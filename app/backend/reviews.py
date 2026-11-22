"""联网口碑：从百度/必应搜索里抓真实用户评价，再用 AI 结构化。

不再只是"给三个链接让用户自己点"，而是把其他平台的评价内容搬进项目：
- 抓取原文（quotes，带来源）
- AI 归纳：主流评价 / 口感画像 / 同好推荐 / 踩雷预警 / 吃法灵感 / 适合人群
"""
import hashlib
import json
import re
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

from . import analyze as analyze_mod
from . import trace_search as ts

# 口碑缓存（同一商品 1 小时内不重复抓取/重复调用模型）
_REVIEW_CACHE = {}  # key -> (写入时间戳, 结果)，1 小时后过期

# 评价性关键词（筛"人话评价句"）
REVIEW_HINTS = [
    "好吃", "难吃", "好喝", "不好喝", "口感", "味道", "太甜", "很甜", "齁", "咸",
    "辣", "脆", "酥", "腻", "香", "回购", "推荐", "踩雷", "踩坑", "一般", "值得",
    "性价比", "包装", "新鲜", "测评", "试吃", "开箱", "童年", "回忆", "经典",
    "解渴", "冰凉", "酸甜", "奶香", "香精", "气泡", "上头", "过瘾", "停不下",
    "清淡", "浓", "软", "硬", "油", "健康", "便宜", "贵", "量", "配料",
]

NOISE_PATTERNS = [
    r"百度百科", r"京东\.com", r"淘宝", r"天猫", r"客服", r"优惠券", r"领券",
    r"登录", r"注册", r"下载", r"APP", r"官网", r"旗舰店", r"加入购物车",
    r"百度为您找到", r"相关搜索", r"京ICP", r"网络营销",
    # 企业介绍类（不是评价）
    r"有限公司", r"集团", r"成立于", r"总部", r"创始人", r"上市公司", r"控股",
    r"前身为", r"创办于", r"跻身", r"荣誉称号", r"销售网络",
    # 视频/平台噪音
    r"哔哩哔哩", r"B站", r"抖音", r"快手", r"短视频", r"西瓜视频", r"视频大全",
    r"\d+年前", r"\d{2}:\d{2}", r"ai\.so\.com", r"FoodTal",
    # 百科/词典/宣传类（不是用户评价）
    r"百科", r"汉典", r"词典", r"拼音", r"汉字", r"学术名词", r"水力学",
    r"定义", r"释义", r"词源", r"成语", r"同义词",
    r"碳中和", r"护地球", r"共享健康", r"跨国食品", r"专注健康", r"品牌史上",
    r"焕新", r"全新升级", r"研发中心", r"合作伙伴", r"企业使命", r"社会责任",
    r"产 品 名 称|产品名称",  # 电商详情页字段
]

# 纯话题标签句过滤
TAG_ONLY = re.compile(r"^(?:[#＃][^\s#＃]+\s*)+$")

# 搜索结果里的来源/日期/用户名前缀（清洗掉，保留评价正文）
_PREFIX_PATTERNS = [
    re.compile(r"^[-–—\s]*[^-–—]{0,30}?\d{4}年\d{1,2}月\d{1,2}日\s*[-–—]\s*"),
    re.compile(r"^[-–—\s]*[^-–—]{0,20}?(昨天|前天|\d+年前|\d+小时前|刚刚)\s*[-–—]\s*"),
    re.compile(r"^(知乎用户|微博用户|网友|匿名用户|用户|楼主)\s*"),
    re.compile(r"^(www\.)?[\w.-]+\.(com|cn|net|org)\s*(反馈)?\s*"),
    re.compile(r"^(知乎|微博|小红书|哔哩哔哩|B站|抖音|百家号|搜狐|网易|新浪)\s*"),
    re.compile(r"^[-–—\s]+"),
]


def _tidy(sentence: str) -> str:
    s = sentence
    for pat in _PREFIX_PATTERNS:
        s = pat.sub("", s).strip()
    return s


def _clean_html(text: str) -> str:
    text = re.sub(r"<script.*?</script>", " ", text, flags=re.S)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;|&#\d+;|&amp;|&lt;|&gt;|&quot;", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _is_noise(sentence: str) -> bool:
    return any(re.search(p, sentence, re.I) for p in NOISE_PATTERNS)


def search_bing(query: str, timeout: int = 20) -> list:
    url = "https://cn.bing.com/search?q=" + urllib.parse.quote(query)
    status, html, _ = ts.http_get(url, timeout=timeout)
    if status != 200 or not html:
        return []
    items = []
    for m in re.finditer(r'<li class="b_algo"(.*?)</li>', html, re.S):
        block = m.group(1)
        a = re.search(r'<h2[^>]*>.*?<a[^>]*href="([^"]+)"', block, re.S)
        t = re.search(r"<h2[^>]*>.*?<a[^>]*>(.*?)</a>", block, re.S)
        p = re.search(r"<p[^>]*>(.*?)</p>", block, re.S)
        title = _clean_html(t.group(1)) if t else ""
        abstract = _clean_html(p.group(1)) if p else ""
        link = a.group(1) if a else ""
        if link.startswith("/"):
            link = "https://cn.bing.com" + link
        if title or abstract:
            items.append({"title": title, "abstract": abstract, "source": "bing", "url": link})
    return items


def search_baidu(query: str, timeout: int = 20) -> list:
    url = "https://www.baidu.com/s?wd=" + urllib.parse.quote(query)
    status, html, _ = ts.http_get(url, timeout=timeout)
    if status != 200 or not html:
        return []
    items = []
    for m in re.finditer(r"<h3[^>]*>(.*?)</h3>(.*?)(?=<h3[^>]*>|$)", html, re.S):
        head = m.group(1)
        a = re.search(r"<a[^>]*href=\"([^\"]+)\"", head)
        ta = re.search(r"<a[^>]*>(.*?)</a>", head, re.S)
        title = _clean_html(ta.group(1) if ta else head)
        abstract = _clean_html(m.group(2))[:320]
        link = a.group(1) if a else ""
        if title and len(title) >= 4:
            items.append({"title": title, "abstract": abstract, "source": "baidu", "url": link})
    return items


def search_text_source(url: str, source: str, timeout: int = 20) -> list:
    """通用文本源：把搜索页转成纯文本后交给句子提取（360/百度移动/搜狗等）"""
    status, html, _ = ts.http_get(url, timeout=timeout)
    if status != 200 or not html:
        return []
    if "验证" in html[:3000] or "captcha" in html[:3000].lower():
        return []
    text = ts.html_to_text(html)
    return [{"title": "", "abstract": text[:30000], "source": source}]


def search_360(query: str) -> list:
    return search_text_source("https://www.so.com/s?q=" + urllib.parse.quote(query), "360")


def search_baidu_mobile(query: str) -> list:
    return search_text_source("https://m.baidu.com/s?word=" + urllib.parse.quote(query), "baidu")


def search_sogou(query: str) -> list:
    return search_text_source("https://www.sogou.com/web?query=" + urllib.parse.quote(query), "sogou")


def _relevant(text: str, name: str, brand: str = "") -> bool:
    """搜索结果是否和商品相关。

    原实现要求「完整商品名连续出现」，对中文名太严：少两个字、中间多个空格、
    或者只提品牌+品类，全被判成无关（实测连「大面筋这种辣条口感偏甜」都丢掉）。
    现在放宽为三条任一命中：
      1. 完整商品名（去掉空格）出现；
      2. 品牌出现，且商品名中任一 2 字以上片段出现；
      3. 商品名里任意连续 3 个字出现（防「经典原味薯片→经典」这类字典解释）。
    """
    if not name:
        return True
    compact_text = re.sub(r"\s+", "", text)
    compact = re.sub(r"[\s,，、/]+", "", name)
    if compact and compact in compact_text:
        return True
    tokens = [t for t in re.split(r"[\s,，、/]+", name) if len(t) >= 2]
    if brand and brand in text:
        if any(t in text for t in tokens):
            return True
        # 品牌对上了，再允许商品名里的任意 2 字片段（「卫龙家的面筋类产品」这种人类一看就相关的）
        if compact:
            for i in range(len(compact) - 1):
                if compact[i:i + 2] in compact_text:
                    return True
    if compact:
        for i in range(len(compact) - 2):
            if compact[i:i + 3] in compact_text:
                return True
    return (not tokens) or any(t in text for t in tokens)


def extract_quotes(items: list, limit: int = 20, name: str = "", brand: str = "") -> list:
    quotes = []
    seen = set()
    source_count = {}  # 每个搜索源最多取 5 条，避免单一来源刷屏
    per_source_max = max(3, limit // 4)
    for item in items:
        item_text = (item.get("abstract") or "") + " " + (item.get("title") or "")
        src = item.get("source", "")
        # 整条结果都不含商品名词 → 丢弃（例如把"经典原味薯片"搜成"经典"的字典解释）
        if not _relevant(item_text, name, brand):
            continue
        if source_count.get(src, 0) >= per_source_max:
            continue
        for sentence in re.split(r"[。！？!?；;\n]", item_text):
            sentence = _tidy(sentence.strip())
            if len(sentence) < 6 or len(sentence) > 120:
                continue
            if _is_noise(sentence) or TAG_ONLY.match(sentence):
                continue
            if not any(h in sentence for h in REVIEW_HINTS):
                continue
            key = sentence[:20]
            if key in seen:
                continue
            seen.add(key)
            quotes.append({"text": sentence, "source": src, "url": item.get("url", "")})
            source_count[src] = source_count.get(src, 0) + 1
            if len(quotes) >= limit:
                return quotes
            if source_count[src] >= per_source_max:
                break
    return quotes


def collect(name: str, brand: str = "", category: str = "") -> dict:
    """抓取某食品的网络评价原文（多搜索源并发，控制在 3-5 秒内）"""
    # 品牌已经写在商品名里时不要重复（原来会出现「卫龙 卫龙大面筋 好吃吗」）
    if brand and brand in name:
        base = name
    else:
        base = " ".join(x for x in [brand, name] if x).strip()
    queries = [f"{base} 好吃吗 评价", f"{base} 口感 测评 怎么样", f"{base} 难吃 吐槽"]
    # 百度 PC 版反爬严重、必应会把中文长查询泛化，实测只有移动版百度/搜狗/360 能出相关内容
    sources = [search_baidu_mobile, search_sogou, search_360, search_baidu, search_bing]
    tasks = [(fn, q) for q in queries for fn in sources]
    all_items = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = [pool.submit(fn, q) for fn, q in tasks]
        for fut in as_completed(futures):
            try:
                all_items.extend(fut.result())
            except Exception:
                pass
    return {"queries": queries, "sources_found": len(all_items),
            "quotes": extract_quotes(all_items, limit=12, name=name, brand=brand), "category": category}


REVIEW_SYSTEM = """你是「食品口碑分析师」。用户会给你一个食品的名称、品类、配料表，以及从网上抓到的真实用户评价原文（可能不全、有噪音）。

请输出**严格的 JSON**（不要任何 JSON 以外的文字）：
{
  "mainstream": "大多数人对它的评价，一句话（大白话，20-40字）",
  "taste": {"label": "口感一句话", "sweet": 0-5, "salt": 0-3, "spicy": 0-3, "crisp": 0-5, "rich": 0-5},
  "highlights": ["精选 2-3 条最典型的真实好评（改写或原文，加为什么典型）"],
  "complaints": ["最常见的 2-3 条吐槽"],
  "similar": ["喜欢这个的人还会吃什么（2-4 个具体品类或食品）"],
  "use_cases": ["最适合的吃法/场景（2-3 个）"],
  "audience": {"good": ["适合谁"], "bad": ["不适合谁"]},
  "innovation": {
    "hack": "一个反常识的吃法灵感（20字内）",
    "pairing": "搭配建议（例如配什么喝、什么时候吃）",
    "warning": "一个容易踩的坑（别被什么骗）"
  }
}

要求：
1. 所有内容基于真实评价归纳，**不编造具体数据**；评价原文没有的就说"网上评价较少"。
2. taste 分数是 0-5 的相对程度（甜/咸/辣/脆/浓郁），根据评价和配料推断（别给太极端）。
3. 语言口语化、像朋友安利/避雷，不要广告腔。
4. 如果抓到的评价太少（<3 条），mainstream 写"网上公开评价较少，以下基于配料推断"，并降低其他字段的肯定语气。"""


def analyze_reviews(name: str, brand: str = "", category: str = "", ingredients: str = "") -> dict:
    """抓取 + AI 结构化口碑（带缓存）"""
    cache_key = hashlib.md5(f"{brand}|{name}|{category}".encode("utf-8")).hexdigest()
    cached = _REVIEW_CACHE.get(cache_key)
    if cached and time.time() - cached[0] < 3600:
        return cached[1]

    raw = collect(name, brand, category)
    quotes = raw["quotes"]
    user_msg = (
        f"【食品】{brand} {name}\n"
        f"【品类】{category or '未知'}\n"
        f"【配料表】{ingredients[:300] or '未提供'}\n\n"
        f"【抓到的网络评价原文（{len(quotes)} 条）】\n"
        + ("\n".join(f"- {q['text']}" for q in quotes) if quotes else "（无）")
        + "\n\n请输出 JSON。"
    )
    try:
        content = analyze_mod._call_llm(REVIEW_SYSTEM, user_msg)
        data = analyze_mod._parse_json(content)
    except Exception as exc:
        return {"error": f"口碑分析失败：{exc}", "quotes": quotes, "raw_count": len(quotes)}

    taste = data.get("taste") or {}
    audience = data.get("audience") or {}
    innovation = data.get("innovation") or {}
    result = {
        "name": name,
        "mainstream": str(data.get("mainstream") or "")[:160],
        "taste": {
            "label": str(taste.get("label") or "")[:60],
            "sweet": _num(taste.get("sweet")), "salt": _num(taste.get("salt")),
            "spicy": _num(taste.get("spicy")), "crisp": _num(taste.get("crisp")),
            "rich": _num(taste.get("rich")),
        },
        "highlights": [str(x)[:120] for x in (data.get("highlights") or [])[:3]],
        "complaints": [str(x)[:120] for x in (data.get("complaints") or [])[:3]],
        "similar": [str(x)[:40] for x in (data.get("similar") or [])[:4]],
        "use_cases": [str(x)[:60] for x in (data.get("use_cases") or [])[:3]],
        "audience": {
            "good": [str(x)[:30] for x in (audience.get("good") or [])[:3]],
            "bad": [str(x)[:30] for x in (audience.get("bad") or [])[:3]],
        },
        "innovation": {
            "hack": str(innovation.get("hack") or "")[:40],
            "pairing": str(innovation.get("pairing") or "")[:80],
            "warning": str(innovation.get("warning") or "")[:80],
        },
        "quotes": quotes,
        "raw_count": len(quotes),
        "taste_has_data": bool(quotes),
    }
    if not quotes:
        # 一条真实评价都没抓到：不给口味分数，免得页面上出现「5 个 0-5 分」却没有任何评价依据
        result["taste"] = {
            "label": "网上公开评价较少，未做口味评分（可看配料表判断）",
            "sweet": 0, "salt": 0, "spicy": 0, "crisp": 0, "rich": 0,
        }
        if not result["mainstream"]:
            result["mainstream"] = "网上公开评价较少，以下内容基于配料表推断，仅供参考。"
    if len(_REVIEW_CACHE) >= 30:
        _REVIEW_CACHE.pop(next(iter(_REVIEW_CACHE)))
    _REVIEW_CACHE[cache_key] = (time.time(), result)
    return result


def _num(v) -> int:
    try:
        return max(0, min(5, int(round(float(v)))))
    except (TypeError, ValueError):
        return 0

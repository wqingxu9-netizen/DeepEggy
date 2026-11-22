"""热度：把「哪款火」拆成几条能查证的信号，并且每个热门商品都说得出依据。

信号来源（全部为公开接口，不需要登录）：
1. 淘宝联想词   suggest.taobao.com      —— 真实搜索需求（用户在搜什么）
2. 拼多多联想词 mobile.yangkeduo.com    —— 真实搜索需求（下沉市场）
3. 百度联想词   suggestion.baidu.com    —— 搜索意图（更偏「怎么吃/有没有害」，权重最低）
4. OpenFoodFacts unique_scans_n         —— 众包真实扫描次数
5. 本站打开次数                          —— 我们自己 Demo 里被点过几次

拿不到的（代码里如实记录，不假装有数据）：
- 京东搜索/销量排序：302 或空响应（数据中心 IP 被拦）
- 微博热搜：403/302 需登录 cookie
- 抖音热榜：需要签名参数
- 小红书：需要签名
- 微信指数 / 百度指数：没有公开接口

产出的每个商品带 score 和 why[]，前端 hover 就能看到「凭什么说它热门」。
"""

import json
import math
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = PROJECT_ROOT / "data" / "hotness"
SUGGEST_FILE = CACHE_DIR / "suggest.json"
SCANS_FILE = CACHE_DIR / "off_scans.json"
CLICKS_FILE = CACHE_DIR / "site_clicks.json"

CACHE_TTL = 6 * 3600          # 联想词缓存 6 小时
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"

# 抓哪些品类词的联想（覆盖货架上主要的几类）
QUERIES = ("薯片", "饼干", "辣条", "牛奶", "酸奶", "饮料", "矿泉水",
           "坚果", "方便面", "面包", "巧克力", "果冻")

W = {"taobao": 3.0, "pdd": 3.0, "baidu": 1.0}   # 各来源权重
SOURCE_NAMES = {"taobao": "淘宝联想词", "pdd": "拼多多联想词", "baidu": "百度联想词"}

# 品类闸门：搜「方便面」时命中的品牌，不该让同品牌的冰红茶也变热门
QUERY_TAGS = {
    "薯片": {"薯片"},
    "饼干": {"饼干"},
    "辣条": {"坚果零食", "方便食品", "其他"},
    "牛奶": {"乳制品"},
    "酸奶": {"乳制品"},
    "饮料": {"饮料", "水", "茶咖"},
    "矿泉水": {"水"},
    "坚果": {"坚果零食", "其他"},
    "方便面": {"方便食品"},
    "面包": {"糕点面包"},
    "巧克力": {"糖果巧克力"},
    "果冻": {"其他"},
}


def _get(url, timeout=6, decode="utf-8"):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode(decode, errors="ignore")


def _taobao(q):
    raw = _get("https://suggest.taobao.com/sug?code=utf-8&q=" + urllib.parse.quote(q))
    data = json.loads(raw)
    return [str(row[0]) for row in (data.get("result") or []) if row]


def _pdd(q):
    raw = _get("https://mobile.yangkeduo.com/proxy/api/search_suggest?query=" + urllib.parse.quote(q))
    data = json.loads(raw)
    return [str(w) for w in (data.get("suggest") or [])]


def _baidu(q):
    raw = _get("https://suggestion.baidu.com/su?wd=" + urllib.parse.quote(q.encode("gbk")),
               decode="gbk")
    m = re.search(r's:\[(.*?)\]', raw)
    if not m:
        return []
    return [w for w in re.findall(r'"([^"]+)"', m.group(1)) if w]


FETCHERS = {"taobao": _taobao, "pdd": _pdd, "baidu": _baidu}


def collect_suggest(force=False):
    """抓一轮联想词（带 6 小时缓存）。返回 {'queries': {query: {source: [words]}}, 'status': {source: 'ok 12/12'}}。"""
    try:
        cached = json.loads(SUGGEST_FILE.read_text(encoding="utf-8"))
        if not force and time.time() - cached.get("ts", 0) < CACHE_TTL:
            return cached
    except (OSError, ValueError):
        pass

    out = {"ts": time.time(), "queries": {}, "status": {}}
    for q in QUERIES:
        row = {}
        for src, fn in FETCHERS.items():
            try:
                words = fn(q)[:10]
                row[src] = words
            except Exception:
                row[src] = []
        out["queries"][q] = row
    for src in FETCHERS:
        ok = sum(1 for q in out["queries"] if out["queries"][q].get(src))
        out["status"][src] = "%d/%d" % (ok, len(QUERIES))
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        SUGGEST_FILE.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    return out


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _brand_keys(brand, name):
    """品牌/系列里用来跟联想词对撞的关键词（至少 2 个字）。"""
    keys = []
    for tok in re.split(r"[,，]", brand or ""):
        tok = max(re.findall(r"[\u4e00-\u9fff]{2,}", tok or ""), key=len, default="")
        if tok and tok not in keys:
            keys.append(tok)
    if not keys:                                  # 没有品牌就用名字里的前 4 个字
        nm = re.sub(r"\s+", "", name or "")
        if len(nm) >= 2:
            keys.append(nm[:4])
    return keys


def score_items(items, suggest=None, scans=None, clicks=None):
    """给每条商品算热度和依据。返回 {code: {'score': x, 'why': [...]}}。"""
    suggest = suggest if suggest is not None else collect_suggest()
    scans = scans if scans is not None else load_json(SCANS_FILE, {})
    clicks = clicks if clicks is not None else load_json(CLICKS_FILE, {})

    scores = {}
    # 1-3. 联想词命中：某品牌出现在「品类词 + 品牌」的联想里，说明用户真在搜
    for q, sources in (suggest.get("queries") or {}).items():
        allowed = QUERY_TAGS.get(q)
        for src, words in sources.items():
            for rank, text in enumerate(words):
                if not text:
                    continue
                for it in items:
                    if allowed and it.get("tag") and it.get("tag") not in allowed:
                        continue
                    hit = next((k for k in _brand_keys(it.get("brand"), it.get("name")) if k in text), None)
                    if not hit:
                        continue
                    pts = W.get(src, 1.0) * max(1.0, 9.0 - rank)
                    rec = scores.setdefault(it["code"], {"score": 0.0, "why": []})
                    rec["score"] += pts
                    if len(rec["why"]) < 3:
                        rec["why"].append("%s「%s」第 %d 位" % (SOURCE_NAMES.get(src, src), text[:18], rank + 1))
    # 4. OpenFoodFacts 众包扫描数
    for it in items:
        n = float(scans.get(it["code"]) or 0)
        if n > 0:
            rec = scores.setdefault(it["code"], {"score": 0.0, "why": []})
            rec["score"] += min(20.0, math.log2(1 + n) * 3.5)
            if len(rec["why"]) < 3:
                rec["why"].append("OpenFoodFacts 被扫 %d 次" % int(n))
    # 5. 本站被打开次数（真实 Demo 行为）
    for it in items:
        n = float(clicks.get(it["code"]) or 0)
        if n > 0:
            rec = scores.setdefault(it["code"], {"score": 0.0, "why": []})
            rec["score"] += min(30.0, n * 5.0)
            if len(rec["why"]) < 3:
                rec["why"].append("本站被打开 %d 次" % int(n))
    return scores


def apply(items, limit=15, per_brand=2):
    """排序 + 打热门标。同一个品牌最多 per_brand 款上榜，避免「一个品牌半个货架都火」。"""
    sig = collect_suggest()
    scores = score_items(items, suggest=sig)
    for it in items:
        rec = scores.get(it["code"]) or {"score": 0.0, "why": []}
        it["hotScore"] = round(rec["score"], 1)
        it["hotWhy"] = rec["why"]
        it["hot"] = 0
    ranked = sorted([it for it in items if it.get("hotScore", 0) > 0], key=lambda x: -x["hotScore"])
    used = {}
    for it in ranked:
        b = (it.get("brand") or it.get("name") or "")[:6]
        if used.get(b, 0) >= per_brand:
            continue
        it["hot"] = 1
        used[b] = used.get(b, 0) + 1
        if sum(used.values()) >= limit:
            break
    items.sort(key=lambda x: (-x.get("hot", 0), -x.get("hotScore", 0)))
    return items


def sources_info():
    """给前端「热度依据」弹层用的元信息。"""
    sig = collect_suggest()
    scans = load_json(SCANS_FILE, {})
    clicks = load_json(CLICKS_FILE, {})
    return {
        "updated": time.strftime("%Y-%m-%d %H:%M", time.localtime(sig.get("ts") or 0)),
        "sources": [
            {"name": "淘宝搜索联想词", "detail": "用户在淘宝搜「%s」时的下拉词，命中品牌即计分" % "、".join(QUERIES[:4]) + "…",
             "status": sig.get("status", {}).get("taobao", "未抓取"), "weight": "高"},
            {"name": "拼多多搜索联想词", "detail": "同上，覆盖下沉市场的搜索习惯",
             "status": sig.get("status", {}).get("pdd", "未抓取"), "weight": "高"},
            {"name": "百度搜索联想词", "detail": "搜索意图，偏「怎么吃/有没有害」，只作辅助",
             "status": sig.get("status", {}).get("baidu", "未抓取"), "weight": "低"},
            {"name": "OpenFoodFacts 扫描次数", "detail": "众包扫码的真实次数",
             "status": ("%d 款有数据" % len(scans)) if scans else "未抓取", "weight": "中"},
            {"name": "本站打开次数", "detail": "最近在 Demo 里被点开的真实次数",
             "status": ("%d 款有记录" % len(clicks)) if clicks else "还没有记录", "weight": "中"},
        ],
        "unavailable": [
            {"name": "京东搜索 / 销量排序", "reason": "数据中心 IP 被拦（302 / 空响应）"},
            {"name": "微博热搜", "reason": "需要登录 cookie（403 / 302）"},
            {"name": "抖音热榜", "reason": "接口需要签名参数"},
            {"name": "小红书笔记数", "reason": "接口需要签名参数"},
            {"name": "微信指数 / 百度指数", "reason": "没有公开接口，抓不了"},
        ],
    }

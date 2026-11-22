"""联网条码补全：条码 → 商品身份 → 配料表检索

分层（全部失败则回退"拍配料表"）：
  1. 本地：内置示例 + OpenFoodFacts 中国离线库（main.py 负责）
  2. OpenFoodFacts 在线（免 key，国内商品覆盖率有限）
  3. 条码服务商 API（需 TANSHU_KEY，直通中国物品编码中心备案数据）
  4. 联网搜索配料表（需 BOCHA_API_KEY，或 TAVILY_API_KEY 兜底）

环境变量（都可不配，未配置则自动跳过对应层）：
  TANSHU_KEY      探数数据条码查询 key（https://www.tanshuapi.com）
  BOCHA_API_KEY   博查 web-search key（https://bochaai.com）
  TAVILY_API_KEY  Tavily search key（https://tavily.com）
"""
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

_TIMEOUT = 7


def _http_json(req, timeout=_TIMEOUT):
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _relevant(text: str, query: str) -> bool:
    """搜索结果是否与查询相关（避免搜索页导航/字典词混入）"""
    keywords = [w for w in re.split(r"[\s]+", query) if len(w) >= 2]
    return any(k in text for k in keywords)


# ---------- 第 2 层：OpenFoodFacts 在线 ----------

_OFF_FIELDS = ("product_name", "product_name_zh", "brands", "categories",
               "quantity", "ingredients_text", "ingredients_text_zh")


# OpenFoodFacts 有些条目把内部编号写进了商品名（如 "12001253 Genki Forest ..."），
# 直接展示给用户很怪，进库前统一清掉前缀编号与多余空格。
_OFF_ID_PREFIX = re.compile(r"^\s*\d{4,}\s*")


def _clean_off_name(name: str) -> str:
    s = _OFF_ID_PREFIX.sub("", str(name or "")).strip()
    return re.sub(r"\s{2,}", " ", s)


def lookup_off_live(code: str):
    """OpenFoodFacts 在线查询单个条码（免 key）。返回统一结构或 None。"""
    try:
        qs = urllib.parse.urlencode({"fields": ",".join(_OFF_FIELDS)})
        url = f"https://world.openfoodfacts.org/api/v2/product/{code}.json?{qs}"
        req = urllib.request.Request(url, headers={"User-Agent": "DeepEggy/1.0"})
        data = _http_json(req, timeout=6)
        if data.get("status") != 1:
            return None
        p = data.get("product") or {}
        name = _clean_off_name(p.get("product_name_zh") or p.get("product_name") or "")
        if not name:
            return None
        ings = (p.get("ingredients_text_zh") or p.get("ingredients_text") or "").strip()
        return {
            "name": name[:60],
            "brand": (p.get("brands") or "").split(",")[0].strip()[:30],
            "category": (p.get("categories") or "").split(",")[-1].strip()[:30],
            "spec": (p.get("quantity") or "").strip()[:20],
            "company": "",
            "image": "",
            "ingredients": ings,  # 非空时前端直接走配料表解读
            "source": "openfoodfacts-live",
        }
    except Exception:
        return None


# ---------- 第 3 层：条码服务商（中国物品编码中心备案数据） ----------

def lookup_cn(code: str):
    """探数数据条码查询（需 TANSHU_KEY）。返回统一结构或 None。"""
    key = os.getenv("TANSHU_KEY", "").strip()
    if not key:
        return None
    try:
        qs = urllib.parse.urlencode({"key": key, "barcode": code})
        url = f"https://api.tanshuapi.com/api/barcode/v1/index?{qs}"
        data = _http_json(urllib.request.Request(url), timeout=8)
        if str(data.get("code")) != "1":
            return None
        d = data.get("data") or {}
        name = (d.get("goods_name") or "").strip()
        if not name:
            return None
        return {
            "name": name[:60],
            "brand": (d.get("brand") or "").strip()[:30],
            "category": (d.get("category_name") or "").strip()[:30],
            "spec": (d.get("spec") or d.get("net_weight") or "").strip()[:20],
            "company": (d.get("company") or "").strip()[:60],
            "image": (d.get("image") or "").strip(),
            "ingredients": "",
            "source": "barcode-api",
        }
    except Exception:
        return None


# ---------- 本地合并总表（队友提供的 16,522 条条码→配料表） ----------

_POOL = None


def _load_pool() -> dict:
    """合并总表：条码 → 商品名/品牌/配料表。命中就免一次联网。"""
    global _POOL
    if _POOL is not None:
        return _POOL
    _POOL = {}
    try:
        p = Path(__file__).resolve().parents[2] / "data" / "barcode_pool.json"
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8")) or {}
            _POOL = data.get("items") or {}
    except Exception:
        _POOL = {}
    return _POOL


def lookup_pool(code: str):
    item = _load_pool().get(code)
    if not item:
        return None
    return {
        "name": (item.get("name") or "")[:60],
        "brand": (item.get("brand") or "")[:30],
        "category": (item.get("category") or "")[:30],
        "spec": (item.get("spec") or "")[:20],
        "company": "",
        "image": "",
        "ingredients": (item.get("ingredients") or "")[:1500],
        "source": "barcode-pool",
    }

def lookup(code: str):
    """条码 → 商品身份。返回 (product, source) 或 (None, None)。"""
    if not code:
        return None, None
    prod = lookup_pool(code)
    if prod:
        return prod, prod["source"]
    prod = lookup_off_live(code)
    if prod:
        return prod, prod["source"]
    prod = lookup_cn(code)
    if prod:
        return prod, prod["source"]
    return None, None


# ---------- 第 4 层：联网搜索配料表 ----------

def search_web(query: str, count: int = 6):
    """联网搜索：博查/Tavily key 优先；未配置 key 时用项目自带的免费搜索（百度/必应/360）"""
    results = []
    bocha = os.getenv("BOCHA_API_KEY", "").strip()
    tavily = os.getenv("TAVILY_API_KEY", "").strip()
    try:
        if bocha:
            payload = json.dumps({"query": query, "summary": True, "count": count}).encode("utf-8")
            req = urllib.request.Request(
                "https://api.bochaai.com/v1/web-search", data=payload,
                headers={"Content-Type": "application/json",
                         "Authorization": f"Bearer {bocha}"})
            data = _http_json(req, timeout=12)
            for w in ((data.get("data") or {}).get("webPages") or {}).get("value") or []:
                results.append({
                    "title": str(w.get("name") or "")[:80],
                    "url": str(w.get("url") or ""),
                    "snippet": str(w.get("summary") or w.get("snippet") or "")[:2000],
                })
        elif tavily:
            # include_raw_content：返回完整网页正文，配料表更可能在正文里
            payload = json.dumps({"api_key": tavily, "query": query,
                                  "max_results": count, "include_raw_content": True}).encode("utf-8")
            req = urllib.request.Request(
                "https://api.tavily.com/search", data=payload,
                headers={"Content-Type": "application/json"})
            data = _http_json(req, timeout=15)
            for w in data.get("results") or []:
                content = w.get("raw_content") or w.get("content") or ""
                results.append({
                    "title": str(w.get("title") or "")[:80],
                    "url": str(w.get("url") or ""),
                    "snippet": str(content)[:3000],
                })
        else:
            # 免费兜底：头条/神马/夸克搜索（文本提取，无风控）
            from app.backend import trace_search as ts
            engines = (
                ("toutiao", "https://so.toutiao.com/search?keyword=" + urllib.parse.quote(query)),
                ("sm", "https://m.sm.cn/s?q=" + urllib.parse.quote(query)),
                ("quark", "https://quark.sm.cn/s?q=" + urllib.parse.quote(query)),
            )
            for name, u in engines:
                try:
                    status, html, _ = ts.http_get(u, timeout=15)
                    if status != 200 or not html:
                        continue
                    text = ts.html_to_text(html)
                    if text:
                        results.append({"title": name + "搜索", "url": "", "snippet": text[:4000]})
                except Exception:
                    continue
    except Exception:
        return []
    # 相关性过滤：标题/摘要必须含查询关键词
    results = [r for r in results if r["snippet"] and _relevant(r["title"] + " " + r["snippet"], query)]
    return results[:count]


def _extract_ingredients_from_pages(results: list):
    """从搜索结果页面正文里直接抠「配料：...」段落（免费、无需 key）"""
    import re as _re
    from app.backend import trace_search as ts
    pat = _re.compile(r"配料[表]?[:：]\s*([^。\n]{10,300})")
    seen = 0
    for r in results:
        url = (r.get("url") or "").strip()
        if not url.startswith("http"):
            continue
        seen += 1
        if seen > 5:
            break
        try:
            real = ts.resolve_redirect(url) if "baidu.com/link" in url else url
            status, html, final = ts.http_get(real, timeout=8)
            if status != 200 or not html:
                continue
            text = ts.html_to_text(html)
            # 正文里找「配料：」段落
            m = pat.search(text)
            if m and len(m.group(1).strip()) >= 8:
                return {"text": m.group(1).strip()[:300], "url": final or real}
        except Exception:
            continue
    return None


# ---------- 扫码 → 联网配料表 → AI 解读（编排） ----------

_EXTRACT_PROMPT = """你是数据核对员。给你一个商品（名称/品牌/规格）和几段网页摘要，判断其中是否包含**这同一款商品**的中文配料表。

输出严格的 JSON：
{"found": true/false, "text": "配料名按原文顺序、用顿号连接（不含'配料：'前缀）", "url": "来源网址", "note": "found=false 时写原因"}

规则：
1. 只认明确写成「配料：」「配料表：」开头的内容，其他一律不算。
2. 必须是同一款商品：品牌一致、品类一致、口味词一致（商品名里的"香蕉味/水蜜桃味"等口味词必须对得上，同品牌不同口味算不匹配）。
3. 找不到就 found=false，**绝不猜测、绝不拼凑**。
4. 提取到的配料名保持原文，不要翻译、不要改写。"""


def _extract_ingredients_web(name: str, brand: str, snippets: list):
    """从网页摘要中提取同一款商品的配料表。返回 {text,url} 或 None。"""
    from app.backend import analyze as analyze_mod
    if not analyze_mod.API_KEY:
        return None
    lines = [f"商品名称：{name}", f"品牌：{brand or '未知'}", "", "网页摘要："]
    for i, s in enumerate(snippets[:5], 1):
        lines.append(f"[{i}] 标题：{s['title']}")
        lines.append(f"    网址：{s['url']}")
        lines.append(f"    内容：{s['snippet']}")
    try:
        raw = analyze_mod._call_llm(_EXTRACT_PROMPT, "\n".join(lines))
        data = analyze_mod._parse_json(raw)
    except Exception:
        return None
    if not data.get("found") or not str(data.get("text") or "").strip():
        return None
    return {"text": str(data["text"]).strip()[:300], "url": str(data.get("url") or "")}


def analyze_barcode(payload: dict) -> dict:
    """扫码后的联网解读编排：搜配料表 → 提取 → AI 解读；失败则 AI 推断。"""
    from app.backend import analyze as analyze_mod
    code = str(payload.get("code") or "").strip()
    name = str(payload.get("name") or "").strip()
    brand = str(payload.get("brand") or "").strip()
    category = str(payload.get("category") or "").strip()
    spec = str(payload.get("spec") or "").strip()

    snippets = search_web(" ".join(x for x in (brand, name) if x) + " 配料表")
    if not snippets:
        snippets = search_web(" ".join(x for x in (brand, name) if x) + " 配料")
    ext = _extract_ingredients_web(name, brand, snippets) if snippets else None
    if not ext:
        # AI 摘要提取失败时，直接抓搜索结果页面正文找「配料：」段落
        ext = _extract_ingredients_from_pages(snippets) if snippets else None

    if ext:
        # 复用主解读链路：把联网拿到的配料表当作干净文本喂进去
        res = analyze_mod.analyze("配料表：" + ext["text"], name=name,
                                  brand=brand or "条码识别", category=category, spec=spec)
        host = urllib.parse.urlparse(ext["url"]).netloc if ext.get("url") else ""
        note = "配料表来自联网检索" + (f"（{host}）" if host else "")
        res["ingNote"] = note + "，可能与实物包装不同，请以实物为准。"
        res["dataSource"] = {"mode": "web", "url": ext.get("url", "")}
    else:
        # 联网没拿到可靠配料表：AI 按品牌+品类推断，并明确标注
        res = analyze_mod.analyze("", name=name, brand=brand or "条码识别",
                                  category=category, spec=spec, inferred=True)
        res["ingNote"] = ("未能联网找到该商品的准确配料表，以下为 AI 按品牌与品类"
                          "典型配方的推断，仅供参考，请以实物包装配料表为准。")
        res["dataSource"] = {"mode": "inferred", "url": ""}
    if code:
        res["barcode"] = code
    return res


def search_available() -> bool:
    return True  # 自有免费搜索始终可用（百度/必应/360）

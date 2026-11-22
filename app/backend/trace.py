"""溯源组装：归一化 → 按注册表路由渠道 → 抽取证据 → 输出产业链节点。

两条硬规则，代码层面强制：
1. confidence == "proven" 必须带 url 与 quote，否则自动降级为 probable。
2. 没有任何证据的环节进 gaps 显式说「查不到」，不生成句子。
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
from datetime import datetime

from .trace_search import (
    fetch_cached,
    find_quotes,
    html_to_text,
    http_get,
    load_registry,
    parse_rss,
    resolve_redirect,
)

REG = load_registry()

# ------------------------------------------------------------------ 归一化

SC_RE = re.compile(r"\bSC(\d{14})\b", re.I)
STD_RE = re.compile(r"\b(GB\s*/?\s*T?\s*\d{3,5}(?:[.\-]\d+)?(?:\s*[-—–]\s*\d{4})?)\b", re.I)
ING_SPLIT = re.compile(r"[、,，;/]+")

# 品类常识表：12 条均未回源核实，只用于「品类常识」展示，禁止进入 provenance 证据链。
# 要升级为证据，必须给该条补一个可点开的来源（政府/行业协会/企业公告），补不上就删。
RAW_PRIORS = {
    "白砂糖": ("甘蔗/甜菜制糖", "广西、云南（甘蔗）；新疆、内蒙古（甜菜）；进口原糖以巴西为主"),
    "白砂糖（蔗糖）": ("甘蔗/甜菜制糖", "广西、云南（甘蔗）；新疆、内蒙古（甜菜）"),
    "果葡糖浆": ("玉米淀粉酶解", "山东、黑龙江、吉林等玉米深加工产区"),
    "高果糖玉米糖浆": ("玉米淀粉酶解", "山东、黑龙江、吉林等玉米深加工产区"),
    "全脂乳粉": ("生鲜乳喷粉", "进口为主：新西兰、澳大利亚、欧盟；国产以内蒙古、黑龙江为主"),
    "脱脂乳粉": ("生鲜乳脱脂喷粉", "进口为主：新西兰、澳大利亚"),
    "乳清粉": ("干酪副产", "进口为主：美国、欧盟"),
    "浓缩苹果汁": ("苹果压榨浓缩", "陕西、山东、山西、新疆"),
    "果汁": ("水果压榨", "随品种与季节变化大，须看具体品种"),
    "维生素C": ("抗坏血酸，玉米发酵路线", "中国为主要生产国，集中在山东、新疆、内蒙古"),
    "赤藓糖醇": ("葡萄糖发酵", "山东为主产区"),
    "二氧化碳": ("食品级气体，多为工业副产回收", "供应商不透明，通常无法追溯到农产品产地"),
}

STAGES = [
    ("raw", "原料产地"),
    ("supplier", "上游供应商"),
    ("factory", "生产加工"),
    ("inspect", "标准与检验"),
    ("brand", "品牌方"),
    ("shelf", "流通上架"),
]


# 标签字段粘连时（OCR 常丢换行），在下一个关键词处截断
FIELD_CUT = re.compile(
    r"(厂址|地址|产地|邮编|电话|配料|保质期|委托方|受托方|监制方|受委托方|生产商|生产企业"
    r"|产品标准号|执行标准|标准号|生产许可证|生产许可|许可证|净含量|储存条件|贮存条件|营养成分)")


def _clean_field(raw: str) -> str:
    s = re.sub(r"\s+", " ", raw or "").strip(" ：:，,、")
    m = FIELD_CUT.search(s, 3)
    if m and m.start() > 6:
        s = s[: m.start()].strip(" ：:，,、")
    return s


def _ingredients(text: str) -> list[str]:
    """配料表是一段连续文本，先定位标记再截断，避免把后面的许可编号吃进原料名。"""
    m = re.search(r"配料(?:表)?[：:]\s*(.+)", text, re.S)
    if not m:
        return []
    seg = re.split(r"保质期|生产许可|产品标准号|储存条件|净含量|委托|地址|产地", m.group(1), maxsplit=1)[0]
    out: list[str] = []
    for part in ING_SPLIT.split(seg):
        p = _clean_field(part)
        if 1 <= len(p) <= 24 and p not in out:  # 「水」是合法单项，不能按长度吞掉
            out.append(p)
    return out[:24]


LABEL_KW = re.compile(
    r"(生产商|生产企业|受委托生产商|受托生产商|受托方|受委托方|监制方|制造商|出品方|委托方|厂址|产地|地址|生产地)[：:]?"
)
COMPANY_HINT = re.compile(r"(公司|集团|厂|合作社|中心|作坊|食品|饮料)")
ADDRESS_HINT = re.compile(r"(省|市|区|县|镇|路|街|号|工业园|产业|大道)")


def _label_fields(text: str) -> tuple[list[str], list[str]]:
    """标签字段是连排文本，先按关键词切段再归类，避免上一项把下一项吃掉。"""
    hits = list(LABEL_KW.finditer(text))
    companies: list[str] = []
    addresses: list[str] = []
    for i, m in enumerate(hits):
        end = hits[i + 1].start() if i + 1 < len(hits) else len(text)
        seg = _clean_field(text[m.end():end])
        if len(seg) < 2:
            continue
        if ADDRESS_HINT.search(seg) and not COMPANY_HINT.search(seg):
            if seg not in addresses:
                addresses.append(seg)
        elif COMPANY_HINT.search(seg) and seg not in companies:
            companies.append(seg)
    return companies[:4], addresses[:4]


def normalize(ocr_text: str = "", product: dict | None = None) -> dict:
    product = product or {}
    text = ocr_text or product.get("ocrText") or ""
    companies, addresses = _label_fields(text)
    return {
        "name": product.get("name", ""),
        "brand": product.get("brand", ""),
        "category": product.get("category", ""),
        "spec": product.get("spec", ""),
        "sc_codes": ["SC" + c for c in SC_RE.findall(text)],
        "std_nos": [re.sub(r"\s+", "", s) for s in STD_RE.findall(text)],
        "label_producers": companies,
        "label_addresses": addresses,
        "ingredients": _ingredients(text),
        "ocr_text": text,
    }


# -------------------------------------------------------------------- 证据


def ev(claim: str, confidence: str, channel: str, url: str = "", quote: str = "",
       kind: str = "page", fetched_at: str | None = None) -> dict:
    if confidence == "proven" and not (quote and (url or kind == "label")):
        confidence = "probable"  # 规则 1：缺可核验出处的，一律不许自称已证实
    return {
        "claim": claim, "confidence": confidence, "channel": channel,
        "source_kind": kind, "url": url, "quote": quote,
        "retrieved_at": fetched_at or datetime.now().astimezone().isoformat(timespec="seconds"),
    }


def _search(query: str, limit: int = 16) -> tuple[list[dict], dict]:
    """双引擎合并去重。实测必须合并：百度对『脉动 生产基地 工厂』整页是软文而无企业词条，
    同查询 Bing 给出百科企业页；反之『元气森林 生产基地 工厂』只有百度排序正确。

    百度/必应被反爬时（结果太少），用 Tavily 联网搜索兜底补证据。
    """
    meta = {"query": query, "engines": [], "error": None}
    merged: list[dict] = []
    for cid in ("baidu_serp", "bing_rss"):
        ch = next(c for c in REG["channels"] if c["id"] == cid)
        url = ch["url"].replace("{query}", urllib.parse.quote(query))
        got = fetch_cached(url, ch)
        body = got.get("text") or ""
        hits = _parse_baidu(body) if cid == "baidu_serp" else (
            parse_rss(body) if got.get("status") == 200 else [])
        if not hits:
            meta["error"] = f"{cid}:{got.get('status') or 'no-hits'}"
            continue
        meta["engines"].append(cid)
        for h in hits:
            if any(m["title"] == h["title"] for m in merged):
                continue
            h["channel"] = cid
            h["retrieved_at"] = got.get("fetched_at")
            h["from_cache"] = bool(got.get("from_cache"))
            merged.append(h)
    # 相关性过滤：标题/摘要必须含查询关键词（避免必应把「农夫山泉」当「农夫」返回音乐组合）
    words = [w for w in query.split() if len(w) >= 2]
    def _relevant(h):
        text = (h.get("title") or "") + " " + (h.get("snippet") or "")
        return any(w in text for w in words)
    filtered = [h for h in merged if _relevant(h)] or merged
    # 兜底：相关结果太少（搜索被风控/降级）→ Tavily 联网补证据
    if len(filtered) < 4:
        try:
            from . import barcode_lookup
            tavily_hits = barcode_lookup.search_web(query, count=8)
            for r in tavily_hits:
                title = (r.get("title") or "").strip()
                url = (r.get("url") or "").strip()
                snippet = (r.get("snippet") or "").strip()
                if not snippet or (url and any(m["url"] == url for m in merged)):
                    continue
                if not _relevant({"title": title, "snippet": snippet}):
                    continue
                merged.append({
                    "title": title or (url[:60] if url else query),
                    "url": url,
                    "snippet": snippet[:300],
                    "channel": "tavily",
                    "retrieved_at": None,
                    "from_cache": False,
                })
            if tavily_hits:
                meta["engines"].append("tavily")
        except Exception:
            pass
        filtered = [h for h in merged if _relevant(h)] or merged
    meta["from_cache"] = all(h.get("from_cache") for h in filtered[:1]) if filtered else False
    return filtered[:limit], meta


BAIDU_H3 = re.compile(r"<h3\b[^>]*>(.*?)</h3>", re.S | re.I)


def _parse_baidu(html_body: str) -> list[dict]:
    """按 <h3> 切窗口取标题/链接/摘要。百度 DOM 版本频繁变动，这里刻意只依赖 h3 与首个外链。"""
    hits = []
    body = html_body or ""
    for m in BAIDU_H3.finditer(body):
        title = _clean(m.group(1))
        if len(title) < 4:
            continue
        window = body[m.start(): m.start() + 3000]
        link = next((u for u in re.findall(r'href="(https?://[^"]+)"', window)
                     if "baidu.com" not in u.split("/")[2] or "/link" in u), "")
        snip = ""
        for cand in re.findall(r'<(?:span|div|p)[^>]*(?:c-span-last|content-right_|c-color-text|c-abstract)[^>]*>(.*?)</(?:span|div|p)>',
                               window, re.S):
            snip = _clean(cand)
            if len(snip) >= 20:
                break
        if not snip:
            tail = _clean(body[m.end(): m.end() + 600])
            snip = tail[:180]
        if any(h["url"] == link and h["title"] == title for h in hits):
            continue
        hits.append({"title": title, "url": link, "snippet": snip[:300]})
    return hits


def _clean(s: str) -> str:
    # 摘要窗口可能把标签截断在半截，只剥字母开头的标签残留，保留「<5g」这类正常写法
    s = re.sub(r"</?[a-zA-Z][^>]*>?", " ", s or "")
    return re.sub(r"\s+", " ", html_to_text(s)).strip()


# UGC/广告域不能作为企业实体证据：实测「灌装机厂家品牌展示-抖音」「百度文库数学题」会混进来
UGC_DOMAINS = ("douyin.com", "zhihu.com", "wenku.baidu", "jingyan.baidu", "tieba.baidu",
               "bilibili.com", "sohu.com", "163.com", "qq.com", "xueqiu.com", "dianping.com")
COMPANY_RE = re.compile(
    r"(有限公司|股份公司|集团|食品厂|饮料厂|酒业|乳业|糖业|果汁|麦芽|淀粉|合作社|农场合|农场)")


# 行业一致性：实测「海天」命中的是海天集团 Haitian Group（注塑机），不是海天味业。
FOOD_HINT = re.compile(
    r"(食品|饮料|味业|乳业|酒业|酿造|粮油|农产品|农业|乳品|啤酒|茶饮|咖啡|水产|肉食|果蔬|糖果|糕点|调味|糖业|淀粉|麦芽|矿泉水)")
NONFOOD_HINT = re.compile(
    r"(塑机|注塑|机械|装备|重工|机床|模具|半导体|软件|地产|置业|医药|化工|纺织|服饰|建材|陶瓷|纸业|印刷|包装机械|汽车|电气)")


def _company_name(title: str) -> str:
    """保留括号——「（安徽）」与「（广东）」正是区分两家主体的关键，不能当描述词删掉。"""
    t = re.split(r"\s+[-_—|｜]\s+| - 百度百科|_百度百科", title or "")[0]
    return re.sub(r"[.…\s]+$", "", t).strip()


def _same_company(a: str, b: str) -> bool:
    na, nb = re.sub(r"\s", "", a or ""), re.sub(r"\s", "", b or "")
    return bool(na and nb) and (na in nb or nb in na)


def _entity_hits(hits: list[dict], brand: str, label_companies=()) -> tuple[list[dict], list[str]]:
    """返回 (保留的实体, 剔除理由)。同名异企要显式说出来，不能静默丢掉也不能并列成链。"""
    out: list[dict] = []
    rejected: list[str] = []
    for h in hits:
        title = h.get("title", "")
        blob = title + h.get("snippet", "")
        if any(d in (h.get("url") or "") for d in UGC_DOMAINS):
            continue
        if not COMPANY_RE.search(title):
            continue
        if brand and brand not in blob:
            continue
        if NONFOOD_HINT.search(blob) and not FOOD_HINT.search(blob):
            rejected.append(f"{_company_name(title)}：疑似同名异行业企业，已剔除")
            continue
        if any(o["title"] == title for o in out):
            continue
        name = _company_name(title)
        same = bool(label_companies) and any(_same_company(name, c) for c in label_companies)
        # 包装已给出生产主体时，名称对不上的命中一律不进链，只进 gap。
        # 实测「海天集团 Haitian Group」（注塑机厂）摘要写「饮料包装 PET 成型方案」，
        # 摘要里偶然的食品词不能当行业一致性的依据；「元气森林(广东)」同理，
        # 与包装「（安徽）」对不上就只能作为待核验线索，不能并列成链。
        if label_companies and not same:
            rejected.append(f"{name}：同名关联企业，与包装标注的生产主体不一致，关系未核实，未列入链")
            continue
        h["relation"] = "与包装标注主体一致" if label_companies else "包装未提供生产主体，无法比对"
        out.append(h)
    return out[:3], rejected


# ------------------------------------------------------------------ 渠道取数


STD_ROW = re.compile(
    r"(\d+)\s+((?:GB|SB|QB|NY|LY)[\s/]*T?\s*[\d.\-]+(?:\s*[-—–]\s*\d{4})?)\s+"
    r"(.{2,60}?)\s+(强标|推标|指导性技术文件|推标)\s+"
    r"(现行|现行有效|废止|即将实施|被代替|备案发布)\s+"
    r"(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2}|—+)"
)
FSMS_NOTE = "食品安全、环境保护、工程建设方面的国家标准未纳入本系统"


def _std_base(no: str) -> str:
    """编号本体：去空白、统一连字符、去年份。GB/T 1354-2018 → GB/T1354"""
    s = re.sub(r"\s+", "", no or "").upper().replace("—", "-").replace("–", "-")
    return re.sub(r"-\d{4}$", "", s)


def _std_year(no: str) -> str:
    m = re.search(r"[-—–](\d{4})\s*$", re.sub(r"\s+", "", no or ""))
    return m.group(1) if m else ""


def select_standard(std_query: str, rows: list[dict]) -> dict:
    """标准号子串检索的纠错闸。

    实测：查 GB/T 1354（大米）首条是「电气绝缘用薄膜」，查 GB/T 1355（小麦粉）是「汽车多楔带」，
    查 GB/T 10781.1 被 GB/T 10781.14 顶掉。所以只接受编号本体精确相等。
    另外包装没印年份时，本品执行的是哪一版未知，禁止把历史版本的「废止」安到本品头上。
    """
    qb, qy = _std_base(std_query), _std_year(std_query)
    exact = [r for r in rows if _std_base(r["std_no"]) == qb]
    near = [r["std_no"] for r in rows if _std_base(r["std_no"]) != qb][:3]
    if qy:
        exact = [r for r in exact if _std_year(r["std_no"]) == qy]
    if not exact:
        return {"matched": [], "near_misses": near, "edition_certain": False,
                "product_status": None,
                "reason": (f"检索只返回同族其他编号/部分（{'、'.join(near)}），非该标准本身，未采信"
                           if near else "全文公开系统无该编号记录，请核对 OCR 是否认错标准号")}

    def rank(r):
        band = 0 if r["status"] in ("现行", "现行有效") else 1 if r["status"] == "即将实施" else 2
        return band, -int(_std_year(r["std_no"]) or 0)

    exact = sorted(exact, key=rank)
    chosen = exact[0]
    return {
        "matched": exact[:2], "chosen": chosen, "near_misses": near,
        "edition_certain": bool(qy),
        "product_status": chosen["status"] if qy else None,
        "reason": "" if qy else
                  "包装未印年份，本品执行版本未核验；下列是该编号在公开系统的收录记录，不等于本品所执行的版本",
    }


def _openstd(std_no: str) -> dict:
    ch = next(c for c in REG["channels"] if c["id"] == "openstd_gb")
    url = ch["url"].replace("{std_no}", urllib.parse.quote(std_no))
    got = fetch_cached(url, ch)
    text = got.get("text") or ""
    base = {"url": url, "fetched_at": got.get("fetched_at"),
            "from_cache": bool(got.get("from_cache")), "rows": [], "reason": ""}
    if not text:
        base["reason"] = "抓取失败（无正文）"
        return base
    for m in STD_ROW.finditer(text):
        base["rows"].append({
            "std_no": re.sub(r"\s+", "", m.group(2)), "name": m.group(3).strip(),
            "kind": m.group(4), "status": m.group(5),
            "published": m.group(6), "effective": m.group(7),
            "quote": m.group(0).strip(),
        })
    if base["rows"]:
        return base
    if FSMS_NOTE in text:
        base["reason"] = (f"{std_no} 属食品安全国家标准，不纳入国家标准全文公开系统，"
                          "应查国家食品安全风险评估中心（CFSA）公布文本")
    elif "共" in text and "条标准" in text and re.search(r"共\s*0\s*条", text):
        base["reason"] = "全文公开系统无该编号记录，请核对 OCR 是否认错标准号"
    else:
        base["reason"] = "未从检索结果解析出标准行，可能是编号写法差异或页面改版"
    return base


def _brand_site(brand: str) -> dict | None:
    site = REG.get("brand_sites", {}).get(brand)
    if not site:  # 空串＝未验真，按注册表约定直接跳过
        return None
    ch = next(c for c in REG["channels"] if c["id"] == "brand_official")
    got = fetch_cached(site, ch)
    text = got.get("text") or ""
    if got.get("status") != 200 or len(text) < 300:
        return None
    q = find_quotes(text, [r"生产厂?地", r"工厂", r"生产基地", r"可持续"], span=70)
    return {"url": site, "chars": len(text), "quotes": q,
            "fetched_at": got.get("fetched_at"), "from_cache": got.get("from_cache", False)}


# -------------------------------------------------------------------- 组链


def build_trace(product: dict, live: bool = True) -> dict:
    t0 = time.time()
    ident = normalize(product.get("ocrText", ""), product)
    brand = ident["brand"] or re.split(r"[ 　]", ident["name"])[:1][0]
    nodes: list[dict] = []
    gaps: list[dict] = []
    prov: list[dict] = []
    cache_hits = 0

    def note(e: dict) -> dict:
        prov.append(e)
        return e

    # --- L1 生产加工：包装标注是最硬的一手证据，不依赖网络
    label_ev = [ev(f"包装标注生产主体：{p}", "proven", "package_label", kind="label", quote=p)
                for p in ident["label_producers"]]
    label_ev += [ev(f"包装标注厂址：{a}", "proven", "package_label", kind="label", quote=a)
                 for a in ident["label_addresses"]]
    # 标签直读到的是 OCR 文本，url 为空 → 按规则降级为 probable；此处显式承认这一降级
    if label_ev:
        nodes.append({"stage": "factory", "title": "生产加工", "items": [
            {"text": e["claim"], "confidence": e["confidence"]} for e in label_ev]})
        [note(e) for e in label_ev]
    else:
        gaps.append({"stage": "factory", "reason": "OCR 文本里没抓到生产商/厂址字段",
                     "next_step": "在核对步骤手工补填包装上的受委托生产商名称"})

    # --- L1 标准与检验
    for std in ident["std_nos"][:3]:
        info = _openstd(std) if live else {"rows": [], "reason": "离线模式未联网"}
        cache_hits += int(info.get("from_cache") or 0)
        verdict = select_standard(std, info["rows"]) if live else {
            "matched": [], "reason": "离线模式未联网", "edition_certain": False}
        items = []
        for r in verdict.get("matched", [])[:2]:
            # 「该系统收录了这条标准」是可证事实；「本品执行这一版」只有包装印了年份才成立
            e = note(ev(f"{r['std_no']}《{r['name']}》", "proven", "openstd_gb",
                        url=info["url"], quote=r["quote"], fetched_at=info["fetched_at"]))
            certain = verdict["edition_certain"]
            items.append({
                "text": e["claim"], "confidence": e["confidence"],
                "extra": f"{r['kind']} · {r['status']} · 发布 {r['published']} · 实施 {r['effective']}",
                # 只有包装明确印了年份，才允许给本品亮「已废止」红灯
                "flag": ("warn" if r["status"] == "废止" else "ok") if certain else "unverified",
                "caveat": verdict.get("reason") or "",
            })
        if items:
            nodes.append({"stage": "inspect", "title": "标准与检验", "items": items})
            if not verdict["edition_certain"]:
                gaps.append({"stage": "inspect", "reason": f"{std} 的本品执行版本未核验",
                             "next_step": "补拍包装上带年份的标准号（如 GB 7101-2022），或查 CFSA 食品安全国标文本"})
        else:
            gaps.append({"stage": "inspect", "reason": verdict.get("reason") or info.get("reason") or "未取到标准记录",
                         "next_step": "若为 OCR 误读，在核对步骤修正标准号后重试"})

    # --- L0/L1 品牌方：官网验真过才抓正文
    official = _brand_site(brand) if live else None
    if official:
        cache_hits += int(official.get("from_cache") or 0)
        for q in official["quotes"][:2]:
            note(ev(f"{brand} 官网公示表述", "proven", "brand_official",
                    url=official["url"], quote=q, kind="self_declared",
                    fetched_at=official["fetched_at"]))
        nodes.append({"stage": "brand", "title": "品牌方",
                      "items": [{"text": f"已抓取 {brand} 官网公示页（{official['chars']} 字符）",
                                 "confidence": "proven", "url": official["url"]}]})
    else:
        nodes.append({"stage": "brand", "title": "品牌方",
                      "items": [{"text": f"{brand or '该品牌'} 官网未收录或抓取失败，未采信任何自述信息",
                                 "confidence": "unknown"}]})
        gaps.append({"stage": "brand", "reason": "brand_sites 白名单里没有该品牌的已验真域名",
                     "next_step": "人工确认官网域名后加入 data/trace_channels.json 的 brand_sites"})

    # --- L2 上游供应商（厂名级线索，来自搜索摘要，只到 probable）
    if live and len(brand) >= 2:
        seq = REG.get("query_templates", {}).get("brand_factory_seq") or [
            REG.get("query_templates", {}).get("brand_factory", "{brand} 生产基地 工厂")]
        used: list[dict] = []
        rejected: list[str] = []
        m: dict = {}
        for tpl in seq:  # 模板有序：第一个拿到合规实体的就停，不做无界重试
            q = re.sub(r"\s+", " ", tpl.replace("{brand}", brand)
                       .replace("{category}", ident["category"])).strip()
            hits, m = _search(q)
            used, rejected = _entity_hits(hits, brand, ident["label_producers"])
            if used:
                break
        for h in used:
            h["url"] = resolve_redirect(h["url"])
        if used:
            items = []
            for h in used:
                note(ev(h["title"], "probable", h.get("channel") or "search", url=h["url"],
                        quote=h["snippet"][:160], kind="serp_snippet",
                        fetched_at=h.get("retrieved_at")))
                items.append({"text": h["title"], "confidence": "probable",
                              "url": h["url"], "why": "搜索摘要所得，未取正文核验",
                              "relation": h.get("relation", "")})
            nodes.append({"stage": "supplier", "title": "上游供应商/关联公司", "items": items})
        cache_hits += int(m.get("from_cache") or 0)
        if rejected:
            gaps.append({"stage": "supplier", "reason": "；".join(rejected[:2]),
                         "next_step": "同名跨行业企业不能当作上游，需人工确认正确法人全称"})
    if not any(n["stage"] == "supplier" for n in nodes):
        gaps.append({"stage": "supplier",
                     "reason": "未能从可用渠道取到关联企业名" if live else "本次为离线模式，未联网",
                     "next_step": "SC 号公开查询渠道目前全部被反爬拦截（见注册表 blocked 项）"})

    # --- L3 原料产地：先验表 12 条均未回源，只能算品类常识，不进 provenance 证据链
    raw_items = []
    common_sense = []
    for ing in ident["ingredients"]:
        key = next((k for k in RAW_PRIORS if k in ing), None)
        if not key:
            continue
        route, origin = RAW_PRIORS[key]
        raw_items.append({"text": f"{key}：{origin}", "confidence": "unverified",
                          "why": "品类常识，未回源核实，也不代表这一瓶的实际来源", "route": route})
        common_sense.append({"ingredient": key, "route": route, "origin": origin,
                             "verified": False, "source": ""})
    if not raw_items:
        gaps.append({"stage": "raw", "reason": "配料表里没有可匹配先验表的农产品原料",
                     "next_step": "扩充 RAW_PRIORS 或人工核对配料识别结果"})
    else:
        nodes.append({"stage": "raw", "title": "原料产地 · 品类常识（未核实）", "items": raw_items})
        gaps.append({"stage": "raw", "reason": "原料产地仅有未回源的品类常识，无一条有来源，不能当作本品溯源结论",
                     "next_step": "逐条补可点开的来源（政府/行业协会/企业公告），补不上的条目删除"})

    # --- 流通
    nodes.append({"stage": "shelf", "title": "流通上架",
                  "items": [{"text": "该环节需要零售端数据，公开网络无来源，不展示推断结果",
                             "confidence": "unknown"}]})

    order = {k: i for i, (k, _) in enumerate(STAGES)}
    nodes.sort(key=lambda n: order.get(n["stage"], 99))

    return {
        "identity": {k: v for k, v in ident.items() if k != "ocr_text"},
        "stages": [{"key": k, "label": l} for k, l in STAGES],
        "nodes": nodes,
        "gaps": gaps,
        "provenance": prov,
        "common_sense": common_sense,
        "meta": {
            "mode": "live" if live else "offline",
            "elapsed_ms": int((time.time() - t0) * 1000),
            "evidence_count": len(prov),
            "proven_count": sum(1 for e in prov if e["confidence"] == "proven"),
            "probable_count": sum(1 for e in prov if e["confidence"] == "probable"),
            "cache_hits": cache_hits,
            "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "registry_last_verified": REG.get("last_verified"),
        },
        "note": ("proven=已取到原文引用；probable=搜索摘要线索未取正文；"
                 "unverified=未核实（品类常识未回源，或本品执行版本未确认），不得当作溯源结论；unknown=查不到。"),
        # 兼容前端现有 trace 字段，便于渐进替换 mock
        "compat": {
            "found": any(e["confidence"] == "proven" for e in prov),
            "place": (ident["label_addresses"] or ident["label_producers"] or ["未识别到厂址"])[0],
            "lines": [n["items"][0]["text"] for n in nodes if n["items"]][:4],
            "source": ", ".join(sorted({e["channel"] for e in prov})) or "无",
        },
    }


# ---------------------------------------------------------------- 叙述（可选）


def narrate(result: dict) -> str:
    """只在有证据的前提下生成一句话解说；没有任何 API 配置时返回空串，绝不即兴编造。"""
    key, base, model = (os.getenv("LING_API_KEY"), os.getenv("LING_BASE_URL"),
                        os.getenv("LING_MODEL"))
    if not (key and base and model):
        return ""
    proven = [e for e in result["provenance"] if e["confidence"] in ("proven", "probable")][:6]
    if not proven:
        return ""
    import http.client
    from urllib.parse import urlparse

    body = json.dumps({
        "model": model,
        "messages": [{
            "role": "user",
            "content": "用不超过60个中文字概括这条溯源链的结论，只允许引用下面 JSON 里已有的事实，"
                       "不得添加任何新地名或新公司名：\n" + json.dumps(proven, ensure_ascii=False),
        }],
    }, ensure_ascii=False).encode()
    u = urlparse(base.rstrip("/") + "/chat/completions")
    conn = http.client.HTTPSConnection(u.netloc, timeout=25)
    try:
        conn.request("POST", u.path, body, {"Content-Type": "application/json",
                                            "Authorization": f"Bearer {key}"})
        r = conn.getresponse()
        if r.status != 200:
            return ""
        data = json.loads(r.read().decode())
        return data["choices"][0]["message"]["content"].strip()
    except Exception:
        return ""
    finally:
        conn.close()


# -------------------------------------------------------------------- 服务


def _json_response(handler, obj, code=200):
    raw = json.dumps(obj, ensure_ascii=False).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(raw)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    handler.end_headers()
    handler.wfile.write(raw)


def serve(port: int = 8010) -> None:
    """零依赖开发服务器：队友没装 FastAPI 也能联调 /api/trace。"""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class H(BaseHTTPRequestHandler):
        def do_OPTIONS(self):  # noqa: N802
            _json_response(self, {})

        def do_POST(self):  # noqa: N802
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n)
            try:
                payload = json.loads(raw.decode("utf-8") or "{}")
            except UnicodeDecodeError:
                return _json_response(self, {"error": "请求体必须是 UTF-8"}, 400)
            except json.JSONDecodeError:
                return _json_response(self, {"error": "bad json"}, 400)
            res = build_trace(payload, live=payload.get("live", True))
            if payload.get("narrate"):
                res["summary"] = narrate(res)
            _json_response(self, res)

        def do_GET(self):  # noqa: N802
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if q.get("health"):
                return _json_response(self, {"ok": True})
            name = q.get("name", ["脉动"])[0]
            _json_response(self, build_trace({"name": name, "brand": name,
                                              "category": "维生素饮料",
                                              "ocrText": q.get("ocr", [""])[0]},
                                             live=True))

        def log_message(self, fmt, *a):
            print("[trace] " + fmt % a, flush=True)

    print(f"溯源接口已启动 http://127.0.0.1:{port}/api/trace  (POST JSON)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()


if __name__ == "__main__":
    import sys

    if "--demo" in sys.argv:
        demo = {
            "name": "脉动 水蜜桃口味维生素饮料", "brand": "脉动", "category": "维生素饮料",
            "spec": "600ml",
            "ocrText": "配料：水、白砂糖、果葡糖浆、柠檬酸、食用香精、维生素C、烟酰胺 "
                       "产品标准号：GB 7101 生产商：达能（中国）食品饮料有限公司 "
                       "厂址：四川省成都市邛崃市工业园区",
        }
        out = build_trace(demo, live=True)
        print(json.dumps(out, ensure_ascii=False, indent=2))
    elif "--serve" in sys.argv:
        serve(int(os.getenv("TRACE_PORT", "8010")))
    else:
        print(__doc__)
        print("用法: python -m app.backend.trace --demo | --serve")

"""DeepEggy 后端入口：静态前端 + 溯源 API（纯标准库，零依赖）

用法：
  python -m app.backend.main            # 默认 0.0.0.0:80
  PORT=8080 python -m app.backend.main  # 自定义端口
  HOST=127.0.0.1 python -m app.backend.main

接口：
  GET  /                    前端页面（app/frontend/ 静态文件）
  GET  /api/health          健康检查
  GET  /api/trace?name=...  溯源（GET 便捷入口）
  POST /api/trace           溯源（JSON：{name, brand, category, spec, ocrText, live, narrate}）
"""
import importlib.util
import json
import os
import re
import ssl
import sys
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent            # app/backend
APP_DIR = BASE_DIR.parent                              # app
PROJECT_ROOT = APP_DIR.parent                          # 项目根
FRONTEND_DIR = APP_DIR / "frontend"
MAX_BODY = 10 * 1024 * 1024                            # 请求体上限 10MB（防大图打爆内存）
OFF_DATA = PROJECT_ROOT / "data" / "openfoodfacts_cn.json"

# 懒加载 OpenFoodFacts 中国商品库（条码 → 商品）
_off_index = None


def _get_off_index():
    global _off_index
    if _off_index is None:
        _off_index = {}
        try:
            data = json.loads(OFF_DATA.read_text(encoding="utf-8"))
            for prod in data.get("products") or []:
                code = str(prod.get("code") or "").strip()
                if code:
                    _off_index[code] = prod
        except (OSError, ValueError):
            pass
    return _off_index

# ---------- 商品索引（首页"商品索引"区）：全库 + 品类标签 ----------
_product_index = None

# 品类归一：OFF 的 categories 中英文混杂，按关键词映射到面向用户的标签。
# 顺序即优先级（如「无糖饮料, 天然矿泉水」先命中"水"而不是"饮料"）。
_TAG_RULES = (
    ("水", ("矿泉水", "饮用水", "纯净水", "天然水", "waters")),
    ("饮料", ("饮料", "汽水", "可乐", "果汁", "气泡", "苏打", "啤酒", "beers", "sodas", "饮品")),
    ("乳制品", ("奶", "乳", "酸奶", "milk", "yogurt")),
    ("茶咖", ("茶", "咖啡")),
    ("薯片", ("薯片", "crisps", "马铃薯")),
    ("饼干", ("饼干", "biscuits", "曲奇", "威化")),
    ("糕点面包", ("面包", "糕点", "蛋糕", "沙琪玛", "muesli", "麦片", "派")),
    ("糖果巧克力", ("糖果", "巧克力", "甜食", "candies", "chocolate", "honeys")),
    ("方便食品", ("方便面", "面饼", "速食", "自热", "方便")),
    ("坚果零食", ("坚果", "零食", "果干", "蜜饯", "snacks")),
)


def _tag_for(categories: str, name: str) -> str:
    cat = (categories or "").lower()
    for tag, keys in _TAG_RULES:
        if any(k in cat for k in keys):
            return tag
    if not cat.strip():  # 品类为空时才用商品名猜（避免"水果糖"被误判成"水"）
        nm = (name or "").lower()
        for tag, keys in _TAG_RULES:
            if any(k in nm for k in keys):
                return tag
    return "其他"


def _get_product_index():
    """全库商品索引：[{code,name,brand,tag,ing}]，ing=1 表示有配料表可直读。

    名字统一走 product_names：每一行都写清「品牌/系列 + 品名」，
    外文名、非食品、纯品类无主体的条目不进索引（条码仍然能查）。
    """
    global _product_index
    if _product_index is None:
        items = []
        seen = set()
        for code, prod in _get_off_index().items():
            raw_name = str(prod.get("name") or "").strip() or code
            raw_brand = str(prod.get("brand") or "")
            raw_cats = str(prod.get("categories") or "")
            if not pnames.usable(code, raw_name, raw_brand, raw_cats):
                continue
            name, brand = pnames.display(code, raw_name, raw_brand, raw_cats)
            key = (name, brand)
            if key in seen:                     # 同一款的多条码只留一条
                continue
            seen.add(key)
            items.append({
                "code": code,
                "name": name[:60],
                "brand": brand[:30],
                "tag": _tag_for(prod.get("categories") or "", name),
                "ing": 1 if len(str(prod.get("ingredients") or "").strip()) >= 4 else 0,
            })
        _product_index = items
    return _product_index + _get_extra_products()


# 补充商品（Tavily 批量抓取的中文零食，无条码，只有名称/品牌/配料）
_extra_cache = {"mtime": 0.0, "items": []}


def _equivalent_gtins(code: str) -> list:
    """同一商品条码的不同等价写法（补齐 14 位后的 8/12/13/14 位表示），精确形式排最前。

    条码校验位不对或非纯数字时只返回原值——宁可查不到，也不把错误数字当成商品。
    """
    if not re.fullmatch(r"(?:\d{8}|\d{12,14})", code) or not any(c != "0" for c in code):
        return [code]
    total = sum(int(c) * (3 if i % 2 == 0 else 1) for i, c in enumerate(code[-2::-1]))
    if (total + int(code[-1])) % 10:
        return [code]
    full = code.zfill(14)
    variants = [code]
    for length in (8, 12, 13, 14):
        if not full[:-length].strip("0"):
            candidate = full[-length:]
            if candidate not in variants:
                variants.append(candidate)
    return variants


def _get_extra_products():
    global _extra_cache
    path = PROJECT_ROOT / "data" / "extra_products.json"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return []
    if _extra_cache["mtime"] == mtime:
        return _extra_cache["items"]
    items = []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        for i, p in enumerate(data.get("products") or []):
            name = str(p.get("name") or "").strip()
            ing = str(p.get("ingredients") or "").strip()
            if not name or len(ing) < 8:
                continue
            if not pnames.usable_extra(name, p.get("brand")):
                continue
            items.append({
                "code": "extra-" + str(i),
                "name": name[:40],
                "brand": str(p.get("brand") or "")[:20],
                "tag": _tag_for(str(p.get("category") or ""), name),
                "ing": 1,
                "extra": 1,
                "ingredients": ing,
            })
    except (OSError, ValueError):
        items = []
    _extra_cache = {"mtime": mtime, "items": items}
    return items


# 热门商品：联网搜"网红零食/爆款"，把出现在热门内容里的商品排到索引前面（缓存 1 小时）
_hot_cache = {"time": 0.0, "text": ""}


def _get_hot_text() -> str:
    """联网抓近期热门零食话题文本（Tavily 优先，失败用免费搜索）"""
    import time as _time
    global _hot_cache
    now = _time.time()
    if _hot_cache["text"] and now - _hot_cache["time"] < 3600:
        return _hot_cache["text"]
    parts = []
    queries = (
        "抖音爆款零食推荐 2025 好吃 学生党",
        "小红书零食推荐 2025 网红 平价",
        "网红零食排行榜 2025 好吃 必吃",
        "最近很火的零食 好吃 推荐 超市",
    )
    try:
        from app.backend import barcode_lookup as bl
        for q in queries:
            try:
                for r in bl.search_web(q, count=6):
                    parts.append((r.get("title") or "") + " " + (r.get("snippet") or "")[:400])
            except Exception:
                continue
    except Exception:
        parts = []
    text = "\n".join(parts)[:8000]
    _hot_cache = {"time": now, "text": text}
    return text


def _hot_score(product: dict, hot_text: str) -> int:
    """旧版热度（话题文本命中）。已由 hotness.py 的多源信号取代，仅保留做对比，不再参与排序。"""
    if not hot_text:
        return 0
    name = str(product.get("name") or "")
    brand = str(product.get("brand") or "")
    # 只匹配含中文的商品名/品牌（热门内容是中文零食话题）
    if not re.search(r"[\u4e00-\u9fff]", name + brand):
        return 0
    score = 0
    if brand and len(brand) >= 2 and brand in hot_text:
        score += 2
    if name and len(name) >= 3 and name in hot_text:
        score += 3
    if name and len(name) >= 4 and name[:4] in hot_text:
        score += 1
    return score


_product_index_hot = None

# 热门零食词提取（从热门话题文本里抠出"xx薯片/xx辣条/xx面包"这类商品词）
# 尾巴只认真实品类词，避免"微头条""其酥脆""层手工开酥"这种被截断的句子
HOT_FOOD_RE = re.compile(
    r"[\u4e00-\u9fff]{2,6}(?:薯片|虾条|辣条|面包|饼干|蛋糕|糕点|巧克力|果冻|饮料|奶茶|咖啡"
    r"|坚果|果干|豆干|肉脯|香肠|方便面|泡面|汽水|酸奶|牛奶|麦片|薯条|米饼|雪饼|锅巴|辣片|糖果)")
HOT_STOP_WORDS = ("零食", "推荐", "好吃", "爆款", "网红", "学生", "平价", "超市", "视频", "抖音", "小红书")

# 联网提取失败或太少时，用上一次抓到的好词兜底（人工也可直接改这个文件）
HOT_WORDS_FILE = PROJECT_ROOT / "data" / "manual" / "hot_words.json"


def _read_hot_words_file():
    try:
        data = json.loads(HOT_WORDS_FILE.read_text(encoding="utf-8"))
        return [w for w in (data.get("words") or []) if isinstance(w, str) and 2 <= len(w) <= 8][:8]
    except (OSError, ValueError):
        return []


def _write_hot_words_file(words):
    try:
        HOT_WORDS_FILE.parent.mkdir(parents=True, exist_ok=True)
        import time as _time
        HOT_WORDS_FILE.write_text(
            json.dumps({"ts": int(_time.time()), "words": words}, ensure_ascii=False, indent=1),
            encoding="utf-8")
    except OSError:
        pass


def _extract_hot_words(hot_text: str) -> list:
    """从热门文本里提取商品词（去重、去泛词/短语）"""
    words = []
    bad_parts = ("可以", "款", "种", "类", "的", "是", "这", "那", "个", "吃", "喝", "买",
                 "好吃", "推荐", "包括", "以及", "例如", "比如", "还有", "就是", "其中", "觉得",
                 "不", "口感", "手工", "层", "微头条", "品牌", "配料")
    for m in HOT_FOOD_RE.finditer(hot_text or ""):
        w = m.group(0).strip()
        if len(w) < 3 or len(w) > 7:
            continue
        if any(s in w for s in HOT_STOP_WORDS) or any(s in w for s in bad_parts):
            continue
        if w not in words:
            words.append(w)
        if len(words) >= 8:
            break
    return words


def _get_product_index_hot():
    """带热度的商品索引（热门置顶）+ 实时热门词"""
    global _product_index_hot, _hotness_sig, _hot_words_cache
    base = _get_product_index()
    stamp = _hotness_stamp()
    if _product_index_hot is None or len(_product_index_hot) != len(base) or stamp != _hotness_sig:
        items = [dict(p) for p in base]
        try:
            hotness.apply(items)            # 淘宝/拼多多/百度联想词 + OFF 扫描数 + 本站点击
        except Exception:
            for it in items:
                it.setdefault("hot", 0)
        _product_index_hot = items
        _hotness_sig = stamp
        if not _hot_words_cache:           # 热门词只抓一次，避免每次重建都联网
            try:
                hot_text = _get_hot_text()
            except Exception:
                hot_text = ""
            words = _extract_hot_words(hot_text)
            if len(words) >= 5:             # 抓得够多就存下来，供下次兜底
                _write_hot_words_file(words)
            else:                           # 抓太少（话题文本质量差）→ 用上次的好词
                saved = _read_hot_words_file()
                if saved:
                    words = saved
            _product_index_hot_words = words
            _hot_words_cache = _product_index_hot_words
    return _product_index_hot


_hot_words_cache = []


def _hotness_stamp():
    """热度数据文件的修改时间。扫描数/点击数是异步补的，变了就重建索引，不用重启。"""
    out = []
    for p in (hotness.SCANS_FILE, hotness.CLICKS_FILE, hotness.SUGGEST_FILE):
        try:
            out.append(p.stat().st_mtime)
        except OSError:
            out.append(0.0)
    return tuple(out)


_hotness_sig = None


def _get_hot_words():
    """实时热门零食词（供前端点选查询）"""
    _get_product_index_hot()
    return _hot_words_cache


_clicks_cache = None


def _log_scan(code, source, product):
    """扫码审计：日志里留下「扫到哪个码 → 命中哪款」，出现串货能直接回查。"""
    name = str((product or {}).get("name") or "未命中")
    try:
        print("[scan] %s -> %s | %s" % (code, source or "-", name[:40]), file=sys.stderr, flush=True)
    except Exception:
        pass


def _bump_click(code):
    """记一次「本站有人打开了这款」。热度里的「站内」一层就是这些真实点击数。"""
    global _clicks_cache
    code = str(code or "").strip()
    if not code:
        return
    if _clicks_cache is None:
        _clicks_cache = hotness.load_json(hotness.CLICKS_FILE, {})
    _clicks_cache[code] = int(_clicks_cache.get(code, 0)) + 1
    try:
        hotness.CLICKS_FILE.parent.mkdir(parents=True, exist_ok=True)
        hotness.CLICKS_FILE.write_text(json.dumps(_clicks_cache, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass

# trace.py 内部用相对导入（from .trace_search import ...），必须以包方式导入
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
from app.backend import analyze as analyze_mod  # noqa: E402
from app.backend import product_names as pnames  # noqa: E402
from app.backend import hotness  # noqa: E402
from app.backend import reviews as reviews_mod  # noqa: E402
from app.backend import trace as trace_mod  # noqa: E402
from app.backend import barcode_lookup as barcode_mod  # noqa: E402


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONTEND_DIR), **kwargs)

    # ---------- 内置示例商品库（条码 → 商品摘要，未收录返回 found=false） ----------
    PRODUCTS = {
        "6902000100029": {"demo": 1, "id": "maidong", "name": "脉动 水蜜桃口味维生素饮料", "brand": "脉动",
                          "category": "维生素饮料", "spec": "600 ml / 瓶"},
        "6970220100058": {"demo": 1, "id": "yuanqi", "name": "元气森林 白桃味气泡水", "brand": "元气森林",
                          "category": "苏打气泡水", "spec": "480 ml / 瓶"},
        "6925303730574": {"id": "milktea", "name": "阿萨姆奶茶 原味", "brand": "统一",
                          "category": "奶茶饮料", "spec": "500 ml / 瓶"},
        "6921168550142": {"id": "weitaming", "name": "力量帝 维他命水 柑橘风味", "brand": "农夫山泉",
                          "category": "营养素饮料", "spec": "500 ml / 瓶"},
    }

    # ---------- 工具 ----------
    def _json(self, obj, code=200):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(raw)

    # ---------- 路由 ----------
    def do_OPTIONS(self):  # noqa: N802
        self._json({})

    def do_POST(self):  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path not in ("/api/trace", "/api/analyze", "/api/ocr", "/api/analyze-barcode",
                        "/api/reviews", "/api/review-page"):
            return self._json({"error": "not found"}, 404)
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._json({"error": f"请求体过大（上限 {MAX_BODY // 1024 // 1024}MB）"}, 413)
        raw = self.rfile.read(n)
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except UnicodeDecodeError:
            return self._json({"error": "请求体必须是 UTF-8"}, 400)
        except json.JSONDecodeError:
            return self._json({"error": "bad json"}, 400)

        if path == "/api/analyze":
            try:
                res = analyze_mod.analyze(
                    payload.get("ocrText", ""),
                    payload.get("name", ""),
                    payload.get("brand", ""),
                    payload.get("category", ""),
                    payload.get("allergens") or [],
                )
            except Exception as exc:  # 不让单个请求拖垮服务
                print(f"[analyze] 错误: {exc!r}", file=sys.stderr, flush=True)
                return self._json({"error": f"解读失败：{exc}"}, 500)
            return self._json(res, 200 if "error" not in res else 502)

        if path == "/api/reviews":
            try:
                res = reviews_mod.analyze_reviews(
                    payload.get("name", ""),
                    payload.get("brand", ""),
                    payload.get("category", ""),
                    payload.get("ingredients", ""),
                )
            except Exception as exc:
                print(f"[reviews] 错误: {exc!r}", file=sys.stderr, flush=True)
                return self._json({"error": f"口碑分析失败：{exc}"}, 500)
            return self._json(res, 200 if "error" not in res else 502)

        if path == "/api/ocr":
            # 接口契约：POST JSON {"imageBase64": "..."} → {"text": "...", "lowConf": [...], "engine": "..."}
            # 路径 A：本地 PaddleOCR-VL（需要 NVIDIA GPU + paddleocr）
            # 路径 B：云 OCR（百度高精度 / 智谱 GLM-4V，只需配置 Key）
            image_b64 = payload.get("imageBase64", "")
            errors = []
            # A. 本地 GPU 版
            try:
                import importlib.util
                if importlib.util.find_spec("paddleocr") is not None:
                    from app.backend import ocr as local_ocr
                    return self._json(local_ocr.recognize(image_b64))
                errors.append("未安装 paddleocr（本地 GPU 版不可用）")
            except Exception as exc:
                errors.append(f"本地 OCR 失败：{exc}")
            # B. 云 OCR
            try:
                from app.backend import ocr_cloud
                if ocr_cloud.available():
                    return self._json(ocr_cloud.recognize(image_b64))
                errors.append("云 OCR 未配置 Key")
            except ImportError:
                errors.append("云 OCR 模块缺失")
            except Exception as exc:
                errors.append(f"云 OCR 失败：{exc}")
            return self._json({"error": "OCR 不可用：" + "；".join(errors)}, 501)

        if path == "/api/review-page":
            # 在项目内部查看评价原文页面：服务端抓取 → 提取正文 → 前端展示
            url = str(payload.get("url") or "").strip()
            if not url:
                return self._json({"error": "缺少原文链接"}, 400)
            try:
                from app.backend import trace_search as ts
                real = ts.resolve_redirect(url)
                status, html, final = ts.http_get(real, timeout=15)
                if status != 200 or not html:
                    return self._json({"error": f"原文页面抓取失败（HTTP {status}）"}, 502)
                m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
                title = ts.html_to_text(m.group(1))[:80] if m else ""
                raw_text = ts.html_to_text(html)
                # 正文清洗：去掉导航/按钮/广告短行
                NAV_WORDS = ("登录", "注册", "下载", "百度首页", "商城", "地图", "更多",
                             "搜索答案", "我要提问", "首页", "反馈", "帮助", "客服",
                             "打开APP", "阅读原文", "分享", "举报", "收藏", "评论")
                lines = [ln.strip() for ln in raw_text.split("\n")]
                keep = []
                for ln in lines:
                    if len(ln) < 10:
                        continue
                    nav_hits = sum(1 for w in NAV_WORDS if w in ln)
                    if nav_hits >= 3:
                        continue  # 一行里多个导航词 = 导航条
                    if nav_hits >= 1 and len(ln) < 40:
                        continue
                    keep.append(ln)
                text = "\n".join(keep) or raw_text
                # 页面正文常被压成一整段：跳过开头导航句，从第一个"像正文"的句子开始
                sentences = re.split(r"(?<=[。！？!?])", text)
                start = 0
                for i, s in enumerate(sentences):
                    if len(s) >= 18 and not any(w in s for w in NAV_WORDS):
                        start = i
                        break
                text = "".join(sentences[start:]).strip()[:5000] or raw_text[:2000]
                return self._json({"url": final or real, "title": title, "text": text})
            except Exception as exc:
                print(f"[review-page] 错误: {exc!r}", file=sys.stderr, flush=True)
                return self._json({"error": f"原文抓取失败：{exc}"}, 500)

        if path == "/api/analyze-barcode":
            # 扫码 → 联网搜配料表 → AI 解读（或推断）。payload: {code,name,brand,category,spec}
            try:
                res = barcode_mod.analyze_barcode(payload)
            except Exception as exc:
                print(f"[analyze-barcode] 错误: {exc!r}", file=sys.stderr, flush=True)
                return self._json({"error": f"联网解读失败：{exc}"}, 500)
            return self._json(res, 200 if "error" not in res else 502)

        # /api/trace
        try:
            res = trace_mod.build_trace(payload, live=bool(payload.get("live", True)))
            if payload.get("narrate"):
                res["summary"] = trace_mod.narrate(res)
        except Exception as exc:  # 不让单个请求拖垮服务
            print(f"[trace] 错误: {exc!r}", file=sys.stderr, flush=True)
            return self._json({"error": f"溯源失败：{exc}"}, 500)
        return self._json(res)

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            return self._json({"ok": True})
        if path == "/api/product":
            # 补充商品详情（extra-xxx）：前端拿到配料后走 AI 解读
            q = urllib.parse.parse_qs(parsed.query)
            code = (q.get("code", [""])[0] or "").strip()
            for p in _get_extra_products():
                if p["code"] == code:
                    return self._json({"found": True, "product": p})
            return self._json({"found": False})
        if path == "/api/products":
            # 商品索引：全部本地商品 + 品类标签 + 热门标记（热门置顶）+ 实时热门词；点击后前端再走 /api/scan-barcode 读详情
            try:
                products = _get_product_index_hot()
                hot_words = _get_hot_words()
            except Exception:
                products = _get_product_index()
                hot_words = []
            return self._json({"total": len(products), "products": products, "hotWords": hot_words})
        if path == "/api/hotness":
            # 热度依据说明：用了哪些信号、抓了多少、哪些拿不到（前端「热度依据」弹层用）
            try:
                info = hotness.sources_info()
            except Exception as e:
                info = {"sources": [], "unavailable": [], "error": str(e)[:120]}
            top = [
                {"name": p.get("name"), "brand": p.get("brand"), "score": p.get("hotScore"),
                 "why": p.get("hotWhy") or []}
                for p in _get_product_index_hot() if p.get("hot")
            ]
            info["top"] = top[:15]
            return self._json(info)
        if path == "/api/trace":
            q = urllib.parse.parse_qs(parsed.query)
            name = q.get("name", [""])[0] or "脉动"
            res = trace_mod.build_trace({
                "name": name, "brand": q.get("brand", [""])[0] or name,
                "category": q.get("category", [""])[0],
                "ocrText": q.get("ocr", [""])[0],
            }, live=(q.get("live", ["1"])[0] != "0"))
            return self._json(res)
        if path == "/api/scan-barcode":
            q = urllib.parse.parse_qs(parsed.query)
            code = (q.get("code", [""])[0] or "").strip()
            candidates = _equivalent_gtins(code)
            prod = self.PRODUCTS.get(code)
            if prod:
                _bump_click(code)
                _log_scan(code, "builtin", prod)
                return self._json({"found": True, "code": code, "matched_code": code, "source": "builtin", "product": prod})
            index = _get_off_index()
            for candidate in candidates:
                prod = self.PRODUCTS.get(candidate)
                if prod:
                    _bump_click(candidate)
                    _log_scan(code, "builtin(等价条码 " + candidate + ")", prod)
                    return self._json({"found": True, "code": code, "matched_code": candidate, "source": "builtin", "product": prod})
                off = index.get(candidate)
                if off:
                    off = dict(off)
                    # 名字同样写清品牌/系列：条码扫出「纯牛奶」时也要说清是哪家的
                    dname, dbrand = pnames.display(candidate, off.get("name"), off.get("brand"))
                    off["name"], off["brand"] = dname, (dbrand or off.get("brand") or "")
                    _bump_click(candidate)
                    _log_scan(code, "openfoodfacts(等价条码 " + candidate + ")", off)
                    return self._json({"found": True, "code": code, "matched_code": candidate, "source": "openfoodfacts", "product": off})
            # 本地都没有 → 联网补全：OpenFoodFacts 在线 + 条码服务商（编码中心备案）
            prod, src = barcode_mod.lookup(code)
            if prod:
                _bump_click(code)
                _log_scan(code, src or "online", prod)
                return self._json({"found": True, "code": code, "source": src, "product": prod})
            _log_scan(code, "未收录", None)
            return self._json({"found": False, "code": code, "product": None})
        if path == "/api/search-product":
            # 按商品名模糊搜索本地商品库（口碑"同好还吃什么"点进去用）
            q = urllib.parse.parse_qs(parsed.query)
            keyword = (q.get("name", [""])[0] or "").strip()
            if not keyword:
                return self._json({"found": False, "products": []})
            results = []
            for code, prod in _get_off_index().items():
                nm = str(prod.get("name") or "")
                brand = str(prod.get("brand") or "")
                if keyword in nm or keyword in brand or (nm and len(nm) >= 2 and nm in keyword):
                    results.append({"code": code,
                                    "name": nm, "brand": brand,
                                    "ingredients": prod.get("ingredients") or "",
                                    "categories": prod.get("categories") or ""})
                    if len(results) >= 5:
                        break
            return self._json({"found": bool(results), "keyword": keyword, "products": results})
        if path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        return super().do_GET()

    def log_message(self, fmt, *args):  # noqa: A003
        sys.stdout.write("[web] " + (fmt % args) + "\n")
        sys.stdout.flush()

    def end_headers(self):
        # 前端迭代频繁：禁止浏览器缓存，保证用户每次拿到最新页面
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main():
    port = int(os.getenv("PORT", "80"))
    host = os.getenv("HOST", "0.0.0.0")
    server = ThreadingHTTPServer((host, port), Handler)

    # 可选 HTTPS：设置 TLS_CERT / TLS_KEY 后启用（手机浏览器要求 HTTPS 才允许调用相机扫码）
    cert = os.getenv("TLS_CERT", "").strip()
    keyfile = os.getenv("TLS_KEY", "").strip()
    scheme = "http"
    if cert and keyfile:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, keyfile)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        scheme = "https"
    print(f"DeepEggy 已启动：{scheme}://{host}:{port}/  （前端 + /api/trace + /api/analyze）", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

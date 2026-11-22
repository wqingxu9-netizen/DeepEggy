"""从包装 OCR 文本里认出「商品名」和「品牌」（拍配料表时用）

背景：拍配料表走的是 OCR → /api/analyze，前端传的 name 是空的，
之前只能让模型从配料文字里猜品名，经常猜成品类（「含乳饮料」）或直接「未命名商品」。

这个模块只做一件事：把包装上**真的写了**的品名读出来。
- 有明确字段（品名 / 产品名称 / 商品名称 / 产品名）→ 直接取，置信 high
- 没有字段 → 在「配料」之前的文字里找最像品名的一行，置信 medium
- 都没有 → 返回 None，由调用方显示「没拍到商品名」，**不猜**
- 品牌：优先「品牌 / 商标」字段；否则从生产商名里去掉公司后缀取品牌名，置信 low

不做的事：不按品类臆造品名、不把「净含量 / 标准号 / 厂址」当品名、不编品牌。
"""

import re

# 字段名（「名称」太泛，会和「企业名称」「商品名称」打架，不收）
NAME_FIELDS = ("产品名称", "商品名称", "产品名", "品名")
BRAND_FIELDS = ("品牌", "商标")
MAKER_FIELDS = ("生产商", "生产企业", "制造商", "生产厂家", "生产单位",
                "委托方", "委托单位", "受托方", "受托单位", "监制方", "监制", "出品方", "出品")

# 这些词出现在候选行里，说明它不是品名
NOISE_WORDS = (
    "配料", "成分", "添加剂", "标准", "净含量", "净重", "规格", "保质期", "生产日期", "贮存", "储存",
    "营养", "致敏", "过敏原", "条码", "执行", "地址", "电话", "网址", "http", "www", "许可证",
    "检验", "食用方法", "冲调", "提示", "产地", "厂址", "生产商", "生产企业", "制造商", "委托",
    "出品", "监制", "sc", "qc", "gb", "qs",
)

# 品类词：出现说明这一行更像品名
CATEGORY_HINTS = (
    "茶", "奶", "水", "饮料", "咖啡", "薯片", "饼干", "糖", "面", "果", "乳", "汽水", "口味", "风味",
    "酥", "糕", "酱", "汁", "粉", "酒", "零食", "坚果", "巧克力", "冰淇淋", "酸奶", "豆", "露",
)

# 公司后缀：从生产商名里剥掉，剩下的才可能是品牌
COMPANY_SUFFIXES = (
    "股份有限公司", "有限责任公司", "有限公司", "集团", "控股", "投资", "企业", "食品", "饮料",
    "实业", "科技", "贸易", "生物", "乳业", "饮品", "公司", "厂",
)


def _clean(value):
    text = re.sub(r"\s+", " ", str(value or ""))
    text = re.sub(r"[®™©]", "", text)          # 商标符号不是名字的一部分
    return text.strip("：:，,。.；;、|·-—_ ")


# 值的右边常常紧跟下一个字段（OCR 一行的多个字段只用空格隔开），切到这里就停
STOP_LABELS = NAME_FIELDS + BRAND_FIELDS + MAKER_FIELDS + (
    "净含量", "配料", "产品标准", "执行标准", "保质期", "生产日期", "规格", "营养", "贮存", "储存",
    "致敏", "过敏原", "条码", "地址", "厂址", "产地", "电话", "网址", "企业名称", "经销商", "监制",
)


def _cut_value(value):
    text = re.split(r"\s{2,}", str(value or ""))[0]
    for label in sorted(STOP_LABELS, key=len, reverse=True):
        position = text.find(label)
        if position > 0:
            text = text[:position]
    return text


def _find_field(text, fields):
    """找「字段：值」；值允许换行（OCR 常把字段和值分成两行）"""
    pattern = r"(?:%s)\s*[：:]?\s*([^\n\r，,；;]{1,40})" % "|".join(fields)
    match = re.search(pattern, text)
    if not match:
        return ""
    value = _clean(_cut_value(match.group(1)))
    # 值本身又是下一个字段名（如「品名 净含量」）→ 不是值
    if any(value.startswith(f) for f in NAME_FIELDS + BRAND_FIELDS + MAKER_FIELDS):
        return ""
    return value


def _brand_from_maker(maker):
    """生产商 → 品牌候选：去括号、剥公司后缀，剩下的 2~8 字"""
    name = re.sub(r"[（(][^）)]*[）)]", "", str(maker or ""))
    name = _clean(name)
    for suffix in COMPANY_SUFFIXES:
        name = name.replace(suffix, "")
    name = name.strip()
    if 2 <= len(name) <= 8:
        return name
    return ""


def _maker_candidates(text):
    """把包装上所有「生产/委托/受托/监制」公司名都收下来（同一字段可能出现多次）"""
    found = []
    for field in MAKER_FIELDS:
        pattern = r"%s\s*[：:]?\s*([^\n\r，,；;]{2,40})" % field
        for match in re.finditer(pattern, text):
            value = _clean(_cut_value(match.group(1)))
            if value and value not in found:
                found.append(value)
    return found


def _brand_from_name(name, makers):
    """品名里出现、且出现在某家公司名里的词，最可能是品牌

    例：品名「安勤90压缩干粮」+ 监制方「北京市安勤应急食品开发有限公司」→ 安勤
    这样能避开 OEM 的委托方/受托方（「安徽陆勤食品研发有限公司」不是品牌）。
    """
    clean_name = re.sub(r"[\s®™©0-9０-９]", "", str(name or ""))
    for size in (4, 3, 2):
        if len(clean_name) < size:
            continue
        prefix = clean_name[:size]
        for maker in makers:
            if prefix in maker:
                return prefix
    return ""


def _prefix_before_ingredients(text):
    """商品名一般在配料表之前；没有「配料」时退回全文开头"""
    cut = re.split(r"配料(?:表)?", text, maxsplit=1)[0]
    return cut if cut.strip() else text


def _tokens(prefix):
    """把前缀切成候选行：换行、两个以上空格、竖线都算分隔"""
    parts = re.split(r"[\n\r]+|\s{2,}|[|·]", prefix)
    out = []
    for part in parts:
        for piece in re.split(r"\s+", part):
            piece = piece.strip()
            if piece:
                out.append(piece)
    return out


def _score(token, position):
    token = _clean(token)
    if not (2 <= len(token) <= 24):
        return -99
    if not re.search(r"[\u4e00-\u9fff]", token):
        return -99
    low = token.lower()
    if any(word in low for word in NOISE_WORDS):
        return -99
    if re.fullmatch(r"[\d\s./%×*+-]+", token):
        return -99
    score = 0
    if any(hint in token for hint in CATEGORY_HINTS):
        score += 2
    if 4 <= len(token) <= 18:
        score += 1
    if position < 3:
        score += 1
    return score


def extract(ocr_text):
    """包装文本 → {name, brand, maker, source, confidence, evidence}

    name 为空字符串表示「包装上没有可读的品名」，调用方应如实说明，不要猜。
    """
    text = str(ocr_text or "")
    result = {"name": "", "brand": "", "maker": "", "source": "", "confidence": "none", "evidence": {}}
    if not text.strip():
        return result

    # 1) 生产商（品牌兜底、也用于结果卡）→ 只在配料前找，避免误吃配料表里的「生产商」两个字
    front = _prefix_before_ingredients(text)[:400]
    makers = _maker_candidates(text)
    maker = _find_field(front, MAKER_FIELDS) or (makers[0] if makers else "")
    if maker:
        result["maker"] = maker[:40]

    # 2) 明确字段
    name = _find_field(front, NAME_FIELDS)
    if name:
        result["name"] = name[:30]
        result["source"] = "field"
        result["confidence"] = "high"
        result["evidence"]["name"] = name[:30]

    # 3) 没有字段：在配料之前的文字里挑一行最像品名的
    if not result["name"]:
        best, best_score, best_pos = "", -99, -1
        for pos, token in enumerate(_tokens(front)):
            score = _score(token, pos)
            if score > best_score:
                best, best_score, best_pos = _clean(token), score, pos
        if best_score >= 3:
            result["name"] = best[:30]
            result["source"] = "line"
            result["confidence"] = "medium"
            result["evidence"]["name"] = best[:30]

    # 4) 品牌字段 → 品名里的品牌词 → 生产商兜底
    brand = _find_field(front, BRAND_FIELDS)
    if brand:
        result["brand"] = brand[:20]
        result["confidence"] = "high" if result["confidence"] == "high" else result["confidence"]
        result["evidence"]["brand"] = brand[:20]
    elif makers:
        derived = _brand_from_name(result["name"], makers) or _brand_from_maker(makers[0])
        if derived:
            result["brand"] = derived
            result["evidence"]["brand_from_maker"] = derived

    if result["name"] or result["brand"]:
        result["source"] = result["source"] or "brand-only"
    return result

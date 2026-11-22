"""商品名规范化：让索引里每一行都写清「哪个品牌 / 哪一款」，
不出现「纯牛奶」「金典」「可口可乐」这种没有主体的品类词。

OpenFoodFacts 的 name 字段质量参差：
- 有的是纯品类（纯牛奶、饮用纯净水、冰红茶）
- 有的是品牌名（金典、冰露、完达山）
- 有的是外文名（Hash Browns、Edam Cheese Sliced），和中国货架无关
- 还有非食品（镜头清洁湿巾、75% 酒精、喉片）

这里统一过一遍：
1. 外文名 / 品牌里没有中文 / 明显不是食品 → 不进索引（条码仍然能查）
2. 名字里已经带品牌或系列的，原样保留（「娃哈哈 饮用纯净水」）
3. 名字是品类词或品牌词的，前面补上系列或公司（「纯牛奶」→「特仑苏 纯牛奶」）
4. 品牌列统一取公司名（「特仑苏, 蒙牛」→ 蒙牛），避免把系列当品牌
5. 少量人工校正放进 OVERRIDES，按条码覆盖
"""

import re

_CJK = re.compile(r"[\u4e00-\u9fff]")

# 「是什么东西」的词库：名字里没有这些词，就说明只写了品牌/系列（伊利、冰露、金典），
# 得从 OFF 的 categories 里补一个具体品名出来。只在没法补时才整条丢掉。
_PRODUCT_NOUNS = (
    # 乳制品
    "牛奶", "鲜奶", "纯奶", "酸奶", "酸乳", "乳饮料", "乳酸菌", "奶粉", "奶酪",
    "芝士", "奶片", "奶昔", "奶",
    # 水 / 饮料
    "矿泉水", "纯净水", "天然水", "饮用水", "苏打水", "气泡水", "汽水", "可乐",
    "果汁", "果蔬汁", "茶饮料", "奶茶", "咖啡", "饮料", "饮品", "啤酒", "果酒",
    "维生素水", "茶", "酒",
    # 零食
    "薯片", "薯条", "薯卷", "虾条", "仙贝", "雪饼", "米饼", "锅巴", "小馒头",
    "泡芙", "蛋卷", "薄脆", "饼干", "曲奇", "威化", "面包", "蛋糕", "糕点",
    "月饼", "沙琪玛", "麻花", "桃酥", "酥饼", "巧克力", "糖果", "软糖", "奶糖",
    "棒棒糖", "口香糖", "果冻", "布丁", "辣条", "面筋", "豆干", "豆皮", "腐竹",
    "素肉", "坚果", "瓜子", "花生", "腰果", "核桃", "巴旦木", "扁桃仁", "开心果",
    "碧根果", "榛子", "夏威夷果", "果干", "蜜饯", "话梅", "山楂", "果脯", "肉脯",
    "肉干", "肉松", "鸭脖", "鸡爪", "鸡翅", "火腿肠", "香肠", "卤味", "罐头",
    "方便面", "拉面", "米线", "米粉", "自热", "麦片", "燕麦", "海苔", "豆腐",
    "果酱", "蜂蜜", "雪糕", "冰淇淋", "冰棒", "食用油", "酱油", "纯生", "土豆",
    "菌菇",
    # 单字兜底（只挑不会出现在非食品里的）
    "面", "肉", "油", "米", "醋", "酱", "派", "酥", "糕",
)

_CAT_SPLIT = re.compile(r"[,，/、;；|]")

# 非食品 / 明显不属于货架零食的商品，直接不进索引
_BLOCK_WORDS = (
    "湿巾", "纸巾", "牙膏", "牙刷", "洗发", "沐浴", "洗衣", "清洁", "洗洁",
    "喉片", "药", "口罩", "奶瓶", "猫粮", "狗粮", "饲料", "种子", "化肥", "农药",
    "酒精", "消毒", "贴纸", "电池", "袜子", "玩具", "香烟", "万金油",
    "维生素", "咀嚼片", "运动营养", "蛋白粉", "钙片", "胶囊", "口服液", "保健食品",
)

# 只有品类、没有主体的名字：前面必须补品牌或系列
_GENERIC = {
    "纯牛奶", "牛奶", "鲜牛奶", "纯牛乳", "酸奶", "老酸奶", "发酵乳", "风味发酵乳",
    "饮用纯净水", "纯净水", "矿泉水", "天然矿泉水", "饮用天然水", "天然水",
    "包装饮用水", "包裝飲用水", "水", "苏打水", "汽水", "盐汽水", "可乐",
    "茶饮料", "柠檬茶", "冰红茶", "绿茶", "红茶", "奶茶", "咖啡", "果汁", "橙汁",
    "薯片", "土豆片", "饼干", "面包", "蛋糕", "糕点", "方便面", "拉面", "火腿肠",
    "香肠", "啤酒", "纯生", "巧克力", "糖果", "奶糖", "瓜子", "坚果", "辣条",
    "豆干", "果冻", "雪糕", "八宝粥", "罐头", "酱油", "老抽", "生抽", "醋",
    "米醋", "料酒", "蚝油", "食用油", "葵花籽油", "大米", "面粉", "挂面", "蜂蜜",
    "豆浆", "麦片", "豆腐", "海苔", "锅巴", "藕片", "藕粉", "花生", "青豆",
    "巴旦木", "腰果", "核桃仁", "西梅", "笋尖", "笋", "凉茶", "气泡水",
}

# 按条码人工校正：(中文名, 公司名)。用于品类词、品牌词、外国小品牌等看不出来的
_OVERRIDES = {
    "6923644266066": ("特仑苏 纯牛奶", "蒙牛"),
    "6907992507095": ("金典 纯牛奶", "伊利"),
    "6928804011142": ("可口可乐 经典原味", "可口可乐"),
    "6954767412573": ("可口可乐 经典原味", "可口可乐"),
    "6954767417684": ("可口可乐 经典原味", "可口可乐"),
    "6901939621608": ("可口可乐 经典原味", "可口可乐"),
    "6901939661604": ("可口可乐 经典原味", "可口可乐"),
    "6901939671603": ("可口可乐 经典原味", "可口可乐"),
    "6954767415772": ("可口可乐 经典原味", "可口可乐"),
    "6921168509256": ("农夫山泉 饮用天然水", "农夫山泉"),
    "6901285991271": ("怡宝 饮用纯净水", "怡宝"),
    "6901285993060": ("怡宝 饮用纯净水", "怡宝"),
    "6901285991530": ("怡宝 饮用纯净水", "怡宝"),
    "6944649700065": ("景田 饮用纯净水", "景田"),
    "6954767470573": ("冰露 饮用纯净水", "可口可乐"),
    "6928804013672": ("纯悦 饮用纯净水", "可口可乐"),
    "6920459902387": ("康师傅 冰红茶", "康师傅"),
    "6920152460061": ("康师傅 红烧牛肉面", "康师傅"),
    "6937962103019": ("康师傅 红烧牛肉面", "康师傅"),
    "6920208942718": ("康师傅 香菇炖鸡面", "康师傅"),
    "6920152497029": ("康师傅 藤椒牛肉面", "康师傅"),
    "6921317905038": ("康师傅 包装饮用水", "康师傅"),
    "6924743919211": ("乐事 经典原味薯片", "乐事"),
    "6923644223458": ("蒙牛 纯牛奶", "蒙牛"),
    "6907992500942": ("伊利 纯牛奶", "伊利"),
    "6955150411456": ("圣牧 有机纯牛奶", "圣牧"),
    "6955150411463": ("圣牧 有机纯牛奶", "圣牧"),
    "6938866513607": ("维维 天山雪 纯牛奶", "维维"),
    "6950418709245": ("完达山 纯牛奶", "完达山"),
    "6921355270297": ("三元 极致 纯牛奶", "三元"),
    "6922577752189": ("君乐宝 优致牧场 纯牛奶", "君乐宝"),
    "6922577727422": ("君乐宝 白小纯 牛奶", "君乐宝"),
    "6907992103952": ("君乐宝 白小纯 牛奶", "君乐宝"),
    "6922577790068": ("简醇 0 蔗糖酸奶", "君乐宝"),
    "6922577704188": ("君乐宝 老酸奶", "君乐宝"),
    "6922577726234": ("君乐宝 涨芝士啦 芝士酸奶", "君乐宝"),
    "6901209216374": ("光明 优倍 鲜牛奶", "光明"),
    "6920584471017": ("旺仔 牛奶饮品", "旺仔"),
    "6906839701016": ("旺仔 奶类饮品", "旺仔"),
    "6921168558049": ("东方树叶 茉莉花茶", "农夫山泉"),
    "6921168559084": ("农夫山泉 抹茶奶茶", "农夫山泉"),
    "6901035603997": ("青岛啤酒 纯生", "青岛啤酒"),
    "6901035615334": ("青岛啤酒 纯生", "青岛啤酒"),
    "6949352200185": ("雪花 纯生", "雪花"),
    "6930755610138": ("老街口 瓜子", "老街口"),
    "6921417900018": ("万悦 天然矿泉水", "万悦"),
    "6941499100052": ("福临门 葵花籽油", "中粮"),
    "6922848641310": ("立顿 黄牌精选红茶", "立顿"),
    "6977026280119": ("盒马 混合菌菇脆", "盒马"),
    "6920907808612": ("好丽友 呀！土豆", "好丽友"),
    "6914973603394": ("士力架 花生夹心巧克力", "士力架"),
    "9556771004972": ("益昌老街 香滑奶茶", "益昌老街"),
    "6901035603584": ("青岛啤酒 经典", "青岛啤酒"),
    "6901035601566": ("青岛啤酒 经典", "青岛啤酒"),
    "6901035606714": ("青岛啤酒 经典", "青岛啤酒"),
    "6901035613651": ("青岛啤酒 经典", "青岛啤酒"),
}
# 明确不进索引（非食品 / 数据错配）
_DROP = {
    "6920560420268",  # 金嗓子喉片（非零食，品牌也对不上）
    "6970968430048",  # 75% 酒精
    "6928804013658",  # 名字只有一个「水」字
    "6901028193498",  # 系滴（空品牌、拼写无意义）
}

_SPLIT = re.compile(r"[,，]")


_CJK_RUN = re.compile(r"[\u4e00-\u9fff·]+")
_COMPANY_TAIL = re.compile(r"(股份有限公司|有限责任公司|有限公司|公司|集团)$")


def _wanted(tok):
    """去掉外文残留，只留中文部分：'Lay\\'s 乐事' → 乐事，'Dove(德芙)' → 德芙。"""
    runs = _CJK_RUN.findall(tok or "")
    return max(runs, key=len) if runs else ""


def _brand_parts(brand):
    """把 OFF 的 brand 字段拆成（公司名, 系列名, 全部中文词）。

    常见形态：「特仑苏, 蒙牛」→ 系列特仑苏、公司蒙牛；
    「东鹏饮料股份有限公司, 补水了」→ 公司东鹏饮料、系列补水了。
    """
    toks = [t.strip() for t in _SPLIT.split(brand or "")]
    zh = [_wanted(t) for t in toks]
    zh = [t for t in zh if t]
    if not zh:
        return "", "", []
    company_tok = next((t for t in zh if _COMPANY_TAIL.search(t)), "")
    if company_tok:                       # 明确写了「…公司」的那个就是公司
        company = _COMPANY_TAIL.sub("", company_tok)
        rest = [t for t in zh if t != company_tok]
        series = rest[0] if rest else ""
        return company, series, zh
    company = zh[-1]
    series = zh[0] if len(zh) > 1 and zh[0] != company else ""
    return company, series, zh


def _clean(name):
    nm = re.sub(r"\s+", " ", (name or "").strip())
    # 「Dove(德芙) 什锦装…」→「德芙 什锦装…」
    nm = re.sub(r"[A-Za-z][A-Za-z'’ .&-]*\(([^)]*[\u4e00-\u9fff][^)]*)\)", r"\1", nm)
    return nm.strip()


def _has_product_noun(name):
    """名字里有没有「是什么东西」的词。没有就说明只写了品牌/系列，不是一款具体的食品。"""
    return any(n in (name or "") for n in _PRODUCT_NOUNS)


def _product_from_categories(categories):
    """从 OFF 的 categories 里挑一个最具体的品名。

    「奶, 全脂灭菌纯牛奶, 牛奶」→ 全脂灭菌纯牛奶
    「无糖饮料, 天然矿泉水, 饮用水」→ 天然矿泉水
    """
    best = ""
    for tok in _CAT_SPLIT.split(categories or ""):
        zh = "".join(_CJK_RUN.findall(tok or ""))
        if len(zh) < 2 or len(zh) > 12:
            continue
        if not _has_product_noun(zh):
            continue
        if len(zh) > len(best):
            best = zh
    return best


def usable(code, name, brand, categories=""):
    """这一条商品能不能进首页索引：必须是「哪个品牌 + 具体哪款食品」。

    两条硬条件：
    1. 品名里得有一个「是什么东西」的词（牛奶 / 薯片 / 面 …）；
       只有品牌名（伊利 / 冰露 / 红牛）、只有系列名、只有外文名的，一律不进。
    2. 品名是纯品类词（纯牛奶 / 饼干）时，必须能补上品牌或系列，否则不知道是哪家的。
    """
    code = str(code or "")
    if code in _DROP:
        return False
    if code in _OVERRIDES:
        return True                       # 人工校对过的，信任 OVERRIDES 里的写法
    nm = _clean(name)
    if not nm or not _CJK.search(nm):
        return False                      # 外文名：中国货架上用不上
    if "?" in nm or "？" in nm:
        return False                      # 名字里带问号 = 抓取残缺（「??奶片」「香酥芝麻 ?」）
    hit = next((w for w in _BLOCK_WORDS if w in nm), None)
    if hit:
        return False                      # 湿巾、酒精之类
    shown, shown_brand = display(code, name, brand, categories)
    if not _has_product_noun(shown):
        return False                      # 补不出品名，只写了个品牌
    if nm in _GENERIC and not shown_brand:
        return False                      # 纯品类又没有主体
    return True


def usable_extra(name, brand):
    """补充商品（Tavily 从真实商品页抓的）也过一遍最基本的筛子。

    名字本来就来自商品页，不要求一定有品牌，但不能是湿巾这类非食品、
    不能是残缺抓取，也不能只剩一个光秃秃的品牌名。
    """
    nm = _clean(name)
    if not nm or not _CJK.search(nm):
        return False
    if "?" in nm or "？" in nm:
        return False
    if any(w in nm for w in _BLOCK_WORDS):
        return False
    if not _has_product_noun(nm) and nm == _clean(brand):
        return False
    return True


def display(code, name, brand, categories=""):
    """返回（写清楚的商品名, 公司名），保证名字里既有主体也有「是什么」。"""
    code = str(code or "")
    if code in _OVERRIDES:
        return _OVERRIDES[code]
    nm = _clean(name)
    company, series, zh = _brand_parts(brand)
    subject = company or series            # 品牌栏只放真正的品牌/系列

    # 名字只写了品牌/系列（伊利、冰露、金典）：从品类里补「是什么东西」
    if nm and not _has_product_noun(nm):
        prod = _product_from_categories(categories)
        if prod and prod not in nm:
            return nm + " " + prod, (subject or nm)
        if not subject:
            return nm, ""                 # 补不出品名，交给 usable 判掉
    if not zh:                            # 品牌栏空着，名字本身已经是完整商品
        return nm, ""
    for t in zh:                          # 名字里已经带品牌词，原样保留
        if t and t in nm:
            return nm, ("" if t == nm else company)
    prefix = series or company
    if not prefix:
        return nm, company
    if nm in _GENERIC or len(nm) <= 6:    # 品类词、品牌词 → 补主体
        return prefix + " " + nm, company
    if not any(t in nm for t in zh):
        return prefix + " " + nm, company
    return nm, company


def __main__demo():  # pragma: no cover - 手动查看用
    import json
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    data = json.loads((root / "data" / "openfoodfacts_cn.json").read_text(encoding="utf-8"))
    rows = []
    seen = set()
    for p in data.get("products") or []:
        code = str(p.get("code") or "")
        cats = str(p.get("categories") or "")
        if not usable(code, p.get("name"), p.get("brand"), cats):
            continue
        nm, br = display(code, p.get("name"), p.get("brand"), cats)
        if (nm, br) in seen:
            continue
        seen.add((nm, br))
        rows.append((nm, br))
    print("索引可用商品：%d 款（原始 837）" % len(rows))
    for nm, br in rows[:60]:
        print("  %-30s %s" % (nm, br))


if __name__ == "__main__":
    __main__demo()

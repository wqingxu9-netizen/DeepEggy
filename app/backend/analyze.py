"""AI 解读：OCR 文本 → 结构化 product 对象（DeepSeek，OpenAI 兼容协议）

环境变量：
  DEEPSEEK_API_KEY   必填
  DEEPSEEK_BASE      默认 https://api.deepseek.com
  DEEPSEEK_MODEL     默认 deepseek-chat
"""
import hashlib
import difflib
import json
import os
import re
import urllib.request

from . import kb
from . import label_name as label_names

API_KEY = os.getenv("DEEPSEEK_API_KEY", "").strip()
API_BASE = os.getenv("DEEPSEEK_BASE", "https://api.deepseek.com").rstrip("/")
MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat").strip()

_CACHE = {}  # ocrText 哈希 → 解读结果（进程内缓存）
_GLOSSARY = None
_ALLERGENS = None
_INGREDIENT_CATALOG = None

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _load_glossary() -> dict:
    """143 条人工整理的配料通俗解释（团队任务包产物）"""
    global _GLOSSARY
    if _GLOSSARY is None:
        _GLOSSARY = {}
        p = os.path.join(ROOT, "data", "ingredient_glossary", "glossary.review.json")
        try:
            with open(p, encoding="utf-8") as source:
                data = json.load(source)
            for ent in data.get("entries") or []:
                cleaned = ent.get("cleaned") or {}
                name = cleaned.get("name") or ent.get("name") or ""
                if name:
                    _GLOSSARY[name] = cleaned
                    for alias in cleaned.get("aliases") or []:
                        _GLOSSARY.setdefault(alias, cleaned)
        except (OSError, ValueError):
            pass
    return _GLOSSARY


def _load_allergens() -> list:
    """25 类致敏物质（GB 7718-2025 14 类核心 + 11 类其他）"""
    global _ALLERGENS
    if _ALLERGENS is None:
        _ALLERGENS = []
        p = os.path.join(ROOT, "data", "allergens.json")
        try:
            with open(p, encoding="utf-8") as source:
                _ALLERGENS = json.load(source).get("categories", [])
        except (OSError, ValueError):
            pass
    return _ALLERGENS


# 常见食品原料不在「食品添加剂」国标表中；这些词与本项目的添加剂、
# 过敏原、人工审核词条一起构成 OCR 的本地配料词库。只用于校正文字，
# 不据此给出安全或合规结论。
_COMMON_INGREDIENTS = (
    "水 白砂糖 食用盐 鸡蛋 蛋黄 蛋清 小麦粉 小麦淀粉 玉米淀粉 玉米粉 大米 糯米 "
    "麦芽糖浆 葡萄糖浆 果葡糖浆 结晶果糖 蜂蜜 植物油 食用植物油 棕榈油 大豆油 菜籽油 "
    "黄油 人造奶油 起酥油 奶油 稀奶油 全脂乳粉 脱脂乳粉 乳粉 生牛乳 鲜牛奶 乳清粉 "
    "炼乳 芝士 干酪 酸奶 乳酸菌粉 可可粉 巧克力 花生 芝麻 坚果 核桃 杏仁 腰果 "
    "椰蓉 豆粉 大豆分离蛋白 豆浆粉 酵母 酵母提取物 食用香精 食用香料 淀粉 糖浆 "
    "山梨糖醇 甘油 麦芽糊精 明胶 卡拉胶 琼脂 海藻酸钠 柠檬酸 碳酸氢钠"
).split()


def _ingredient_catalog() -> dict:
    """Build {OCR surface: canonical ingredient} from backend-owned datasets."""
    global _INGREDIENT_CATALOG
    if _INGREDIENT_CATALOG is None:
        catalog = {}
        for name in _COMMON_INGREDIENTS + kb.ingredient_names():
            catalog.setdefault(name, name)
        for surface, ent in _load_glossary().items():
            canonical = (ent.get("name") or surface).strip()
            if surface and canonical:
                catalog.setdefault(surface.strip(), canonical)
        for group in _load_allergens():
            for name in group.get("items") or []:
                if name:
                    catalog.setdefault(str(name).strip(), str(name).strip())
        _INGREDIENT_CATALOG = catalog
    return _INGREDIENT_CATALOG


_INGREDIENT_END = re.compile(
    r"(?:致敏物质|过敏原|产品标准|贮存条件|储存条件|食用方法|营养成分表|营养成份表|"
    r"生产日期|保质期|净含量|生产商|委托方|条码|二维码|执行标准)"
)


def extract_ingredient_text(ocr_text: str) -> str:
    """Keep only the ingredient-list area from a whole-package OCR response."""
    lines = [re.sub(r"\s+", "", line) for line in (ocr_text or "").splitlines()]
    start = next((i for i, line in enumerate(lines) if re.search(r"配料(?:表)?[：:]?", line)), None)
    if start is None:
        return ""
    kept = []
    for line in lines[start:start + 12]:
        if kept and _INGREDIENT_END.search(line):
            break
        kept.append(line)
    # Baidu returns visual text rows. Join rows so a wrapped ingredient such as
    # 「小」+「麦粉」is restored; normalize_ingredients later separates any
    # accidental adjacency of two known ingredient names.
    text = "".join(kept)
    text = re.sub(r"^.*?配料(?:表)?[：:]?", "", text, count=1)
    return _INGREDIENT_END.split(text, maxsplit=1)[0].strip("，,、；;。 ")


def _ocr_key(value: str) -> str:
    return re.sub(r"[\s()（）\[\]【】·•]", "", value or "")


def match_ingredient(name: str) -> str:
    """Match a single OCR token to the local ingredient catalog conservatively."""
    raw = _ocr_key(name)
    if not raw:
        return ""
    catalog = _ingredient_catalog()
    if raw in catalog:
        return catalog[raw]
    candidates = [key for key in catalog if len(raw) >= 4 and abs(len(key) - len(raw)) <= 1]
    hit = difflib.get_close_matches(raw, candidates, n=1, cutoff=0.82)
    return catalog[hit[0]] if hit else raw


def _match_token(token: str) -> list:
    """Match a token, or split two adjacent *known* names caused by OCR rows."""
    raw = _ocr_key(token)
    if not raw:
        return []
    catalog = _ingredient_catalog()
    if raw in catalog:
        return [catalog[raw]]
    # Only split on exact local-dictionary words. This handles an OCR row break
    # after「起酥油」without inventing a split for an unfamiliar ingredient.
    for pos in range(2, len(raw)):
        left, right = raw[:pos], raw[pos:]
        if left in catalog and right in catalog:
            return [catalog[left], catalog[right]]
    return [match_ingredient(raw)]


_GROUP_WORDS = ("食品添加剂", "复配食品添加剂", "食品添加剂（", "食品添加剂(")


def _flatten_brackets(text: str) -> str:
    """括号里的配料拆到平铺序列，括号里的「说明」丢掉。

    两种括号，规则不一样：
    - 括号里有顿号/逗号 = 复合配料或分组括号（GB 7718 要求展开）→ 拆开当独立配料
      「植脂末（葡萄糖浆、植物油）」→ 植脂末、葡萄糖浆、植物油
      「食品添加剂（碳酸氢钠、柠檬酸钠）」→ 碳酸氢钠、柠檬酸钠（分组词下面会被跳过）
    - 括号里只有一项 = 备注/别名/功能类别，不是配料 → 整段丢掉
      「碳酸氢钠(膨松剂)」→ 碳酸氢钠　「维生素B₁(盐酸硫胺素)」→ 维生素B₁
    这样既不会把「食品添加剂碳酸氢钠」粘成一个不存在的名字，也不会凭空多出「膨松剂」这种东西。
    """
    pattern = re.compile(r"[（(]([^（）()]*)[）)]")
    for _ in range(3):            # 允许一层嵌套；再深也不会出现第三种语义
        replaced = pattern.sub(
            lambda m: ("、" + m.group(1) + "、") if re.search(r"[、,，;；]", m.group(1)) else "、",
            text,
        )
        if replaced == text:
            break
        text = replaced
    return text


def normalize_ingredients(ocr_text: str) -> list:
    """Extract the label section, split it, and normalize known ingredients."""
    segment = extract_ingredient_text(ocr_text)
    if not segment:
        return []
    tokens = re.split(r"[、,，;；\n]+", _flatten_brackets(segment))
    result = []
    for token in tokens:
        token = re.sub(r"^[：:]+", "", token).strip().rstrip("。、")
        token = re.sub(r"[®™©]", "", token).strip()
        if not token or len(token) > 32:
            continue
        if token in _GROUP_WORDS or token.startswith("食品添加剂"):
            continue          # 分组标题不是配料
        for matched in _match_token(token):
            if matched and matched not in result:
                result.append(matched)
    return result[:25]


def glossary_context(ingredients: list) -> str:
    """配料 → 人工整理的标准释义（注入提示词，让模型优先采用团队审定的说法）"""
    g = _load_glossary()
    lines = []
    for ing in ingredients:
        key = (ing or "").strip()
        ent = g.get(key)
        if not ent:
            continue
        what = ent.get("what") or ""
        uses = ent.get("uses") or ""
        if what:
            lines.append(f"{key}：{what}" + (f"；常见用途：{uses}" if uses else ""))
        if len(lines) >= 10:
            break
    return "\n".join(lines)


def match_allergens(ingredients: list) -> list:
    """配料 → 命中的致敏物质类别（后端匹配，供提示词与结果使用）

    匹配规则：多字词用包含匹配；单字词只在配料名恰好等于该字时匹配
    （避免「山梨酸钾」误匹配「梨」这类误报）。
    """
    hits = []
    for cat in _load_allergens():
        items = cat.get("items") or []
        if not items:
            continue
        matched = []
        for ing in ingredients:
            name = (ing or "").strip()
            if not name:
                continue
            hit = any((len(k) >= 2 and k in name) or k == name for k in items)
            if hit and name not in matched:
                matched.append(name)
        if matched:
            hits.append({
                "id": cat.get("id"), "name": cat.get("name"), "full": cat.get("full"),
                "group": cat.get("group"), "matched": matched,
            })
    return hits

SYSTEM_PROMPT = """你是「配料表翻译官」，帮普通消费者看懂**食品**配料表。用户会给你包装上的配料表文字（OCR 识别，可能有错字）。

请输出**严格的 JSON**（不要输出任何 JSON 以外的文字），字段如下：
{
  "product": {"name": "商品名或品类（看不出写'未知产品'）", "category": "按你的判断写：饮料/乳制品/零食/饼干糕点/糖果巧克力/方便食品/调味品/其他"},
  "verdict": {"level": "good|caution|bad", "label": "可以买|慎买|不推荐", "why": "一句话大白话理由"},
  "keys": [{"l": "关键指标名", "v": "数值", "u": "单位", "hi": true}],
  "ingredients": [{"name": "配料名", "flag": "green|yellow|red", "role": "作用（4字内）", "what": "是什么（大白话）", "why": "为什么加（可选）", "caution": "要注意什么（可选）"}],
  "nutrition": [{"name": "营养素", "per100": "每100g/mL含量", "whole": "按规格折算", "nrv": 0, "cm": "大白话点评", "hi": false}],
  "equiv": [{"big": "≈ 直观换算", "small": "换算说明"}],
  "tricks": [{"claim": "营销话术", "ok": false, "edu": false, "truth": "真相大白话", "basis": "国标依据"}],
  "pairs": [{"with": "搭配或场景", "why": "为什么要注意"}],
  "health": [{"tag": "人群标签", "level": "risk|good", "text": "建议"}]
}

**第一步：判断品类**，再按品类给指标和换算：
- 饮料/乳饮料：糖、能量、蛋白质；按整瓶折算（ml），糖换算成「方糖」（1 块≈4.5g）
- 乳制品：蛋白质、钙、糖；按整盒/盒装折算
- 零食（薯片、饼干、辣条、坚果）：**能量密度、脂肪、钠、糖**；按整袋/每份折算（g），能量换算成「≈ 几碗米饭」（1 碗≈230kcal）或「≈ 多少克油」，钠换算成「≈ 多少克盐」（1g 盐≈400mg 钠）
- 糖果/巧克力：糖、能量、脂肪；按颗/块折算
- 方便食品/面：钠、脂肪、能量；按整包折算
- 调味品：钠、糖；按每次用量折算
- 其他：挑最关键的 2-3 个

规则：
1. 全部用大白话，每条 30 字以内；多打比方（方糖、米饭、盐、油）。
2. 过敏原（乳、蛋、花生、坚果、麸质、大豆、鱼虾等）必须标 red，并在 caution 写清。
3. 「0蔗糖」不等于「无糖」：配料里有结晶果糖、果葡糖浆、蜂蜜、麦芽糖浆等，必须在 tricks 里拆穿。
4. flag 标准：red=需要警惕（高糖/高钠/高脂/过敏原/争议添加剂），yellow=适量没事，green=安全。
5. 数字（含量）以文本为准，读不到写「未标注」，**绝不编造数字**。
6. 成分按配料表原始顺序，最多 15 项。
7. 依据：GB 2760（添加剂使用）、GB 28050（无糖≤0.5g/100g、低糖≤5g/100g、无能量≤17kJ/100g）、GB 7718（标签）。
8. keys 给 2-3 个最重要指标：**有营养数字就用数字**（如{"l":"糖","v":"34.8","u":"g/瓶"}）；**读不到数字就给定性判断**（如{"l":"糖","v":"偏高","u":"配料表第2位"}、{"l":"钠","v":"不低","u":"调味料多"}），不要连续写「未标注」。
9. nutrition 给能读到的营养素；一个都读不到就留空数组（前端会说明"按配料表说"）。
9. **按实际规格折算**（包装上的"每袋/每包/每瓶/每份"都要用对单位），不知道规格就按每 100g 给。"""


def _call_llm(system: str, user: str) -> str:
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.3,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        API_BASE + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]


def _parse_json(text: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`").strip()
        if text.lower().startswith("json"):
            text = text[4:].strip()
    return json.loads(text)


def parse_ingredients(text: str) -> list:
    """Compatibility wrapper for callers that need normalized ingredient names."""
    return normalize_ingredients(text)


def _fill_ingredient(it: dict) -> dict:
    return {
        "name": str(it.get("name") or "").strip(),
        "flag": it.get("flag") if it.get("flag") in ("green", "yellow", "red") else "yellow",
        "role": str(it.get("role") or "").strip(),
        "what": str(it.get("what") or "未识别").strip(),
        "why": str(it.get("why") or "").strip(),
        "caution": str(it.get("caution") or "").strip(),
    }


def choose_name(caller_name: str, label_info: dict, model_name: str, category: str = "") -> tuple:
    """商品名优先级：调用方（条码库/用户输入）> 包装上读到的 > 模型判断 > 品类兜底

    返回 (name, source)，source ∈ caller / label / label-inferred / model / none。
    拍配料表时调用方没有品名，label_info 就是「从包装文字里读到的」那一份；
    读不到时不给模型留编造空间，直接落到品类兜底并标 none（前端会说明没拍到品名）。
    """
    caller = str(caller_name or "").strip()
    if caller and caller not in ("未知产品", "未知商品", "未知"):
        return caller, "caller"
    label = str((label_info or {}).get("name") or "").strip()
    if label:
        high = (label_info or {}).get("confidence") == "high"
        return label, ("label" if high else "label-inferred")
    model = str(model_name or "").strip()
    if model and model not in ("未知产品", "未知商品", "未知"):
        return model, "model"
    cat = str(category or "").strip()
    if cat and cat not in ("未知品类", "未知", "其他"):
        return f"{cat}（按配料判断）", "none"
    return "未命名商品", "none"


def analyze(ocr_text: str, name: str = "", brand: str = "", category: str = "",
            selected_allergens: list = None, spec: str = "", inferred: bool = False) -> dict:
    """OCR 文本 → product 对象（与前端 mock 数据结构对齐）

    selected_allergens: 用户勾选的过敏原类别 id 列表（用于过滤返回的命中项；
    不传或为空时返回全部命中）。
    spec: 商品规格（来自条码库），写进结果卡。
    inferred: True 时表示没有真实配料表，让模型按品牌+品类推断典型配方，
    并在结果中明确标注，绝不允许编造营养数字。
    """
    if not API_KEY:
        return {"error": "服务端未配置 DEEPSEEK_API_KEY"}

    # 同一个配料表文本 + 同一批过敏原勾选 + 同一款商品（名称/品牌/品类/规格）+ 同一模式
    # 只调一次模型（简单内存缓存，最多 50 条）。
    # 注意：扫条码/推断模式的 ocr_text 是空串，键里必须带上商品身份，
    # 否则不同商品会命中同一条缓存（曾出现「扫红豆薏米水显示出阿萨姆」）。
    cache_key = hashlib.md5(
        (
            (ocr_text or "")
            + "|" + ",".join(sorted(selected_allergens or []))
            + "|" + str(name or "").strip()
            + "|" + str(brand or "").strip()
            + "|" + str(category or "").strip()
            + "|" + str(spec or "").strip()
            + "|" + ("inferred" if inferred else "exact")
        ).encode("utf-8")
    ).hexdigest()
    if cache_key in _CACHE:
        return _CACHE[cache_key]

    ings = parse_ingredients(ocr_text)
    # 拍配料表时调用方没有品名：先从包装文字里读出「包装上真的写了什么」，
    # 读不到就留空（下面 choose_name 会落到品类兜底并标明没拍到）。
    label_info = label_names.extract(ocr_text)
    # Do not feed a whole package OCR dump to the model: storage instructions,
    # standard numbers and nutrition-table fragments are not ingredients.
    ingredient_text = "配料：" + "、".join(ings) if ings else (extract_ingredient_text(ocr_text) or ocr_text)
    kb_ctx = kb.ingredients_context(ings)
    gloss_ctx = glossary_context(ings)
    alg_all = match_allergens(ings)
    # 只保留用户勾选的过敏原类别（未勾选时返回全部命中，供"为你"页展示）
    sel = set(selected_allergens or [])
    alg_hits = [h for h in alg_all if h["id"] in sel] if sel else alg_all

    user = f"【已从包装 OCR 自动提取并匹配的配料表】\n{ingredient_text or '（空）'}\n\n"
    if label_info.get("name"):
        user += (
            f"【包装上读到的商品名】{label_info['name']}"
            "（照抄进 product.name，不要改写；只有明显不是商品名时才按你的判断写）\n\n"
        )
    elif label_info.get("maker"):
        user += f"【包装上读到的生产商】{label_info['maker']}（可作 product.name 的线索，但不许据此编品名）\n\n"
    if category:
        user += f"【商品品类参考（来自条码库/用户输入）】{category}\n\n"
    if inferred:
        user += (
            "【特殊模式：无真实配料表】该商品联网未找到可靠配料表。"
            "请基于你对这个品牌、这个品类的了解，推断典型配方作为 ingredients 输出；\n"
            "- 每个配料是你推断的，不是读到的：凡不确定的配料，caution 里写明「推断」；\n"
            "- nutrition 与 keys 一律留空数组，**绝不编造任何数字**；\n"
            "- equiv 留空数组；verdict.why 开头加「按同类配方推断：」；\n"
            "- 过敏原仍必须标 red（品类必有者，如饼干的小麦/蛋）。\n\n"
        )
    if kb_ctx:
        user += f"【GB 2760 权威参考（可用作事实依据）】\n{kb_ctx}\n\n"
    if gloss_ctx:
        user += f"【团队人工整理的标准释义（请优先采用这些说法）】\n{gloss_ctx}\n\n"
    if alg_hits:
        user += "【已检测到致敏物质（必须在过敏原提示中体现）】\n" + "、".join(
            f"{h['full']}（配料：{'、'.join(h['matched'])}）" for h in alg_hits) + "\n\n"
    user += "请按规则输出 JSON。"

    try:
        raw = _call_llm(SYSTEM_PROMPT, user)
        data = _parse_json(raw)
    except Exception as exc:  # 模型/网络错误
        return {"error": f"AI 解读失败：{exc}"}

    prod = data.get("product") or {}
    verdict = data.get("verdict") or {}
    model_ingredients = data.get("ingredients") or []
    if ings:
        # Keep the visible list tied to the locally extracted/matched order.
        # The model is used for explanation only, so it cannot reintroduce a
        # storage instruction or silently replace an OCR ingredient.
        explanations = {}
        for item in model_ingredients:
            if isinstance(item, dict) and item.get("name"):
                explanations.setdefault(_ocr_key(str(item["name"])), item)
        visible_ingredients = []
        for ingredient in ings[:15]:
            item = dict(explanations.get(_ocr_key(ingredient), {}))
            item["name"] = ingredient
            visible_ingredients.append(_fill_ingredient(item))
    else:
        visible_ingredients = [_fill_ingredient(it) for it in model_ingredients[:15] if isinstance(it, dict)]
    if not visible_ingredients:
        # 模型没给出任何可用配料（少见但会发生，比如商品名是英文/编号、联网也没抓到配料表）：
        # 宁可明确说「没读到」，也不要弹一张空结果卡。
        return {"error": "AI 没读懂这款商品（配料表没读到），请拍一张包装上的配料表再试"}
    # 商品名优先级：调用方传入（条码库/用户输入）> 包装上读到 > 模型判断 > 品类兜底
    prod_name = str(prod.get("name") or "").strip()
    caller_name = str(name or "").strip()
    raw_name, name_source = choose_name(
        caller_name, label_info, prod_name, category or str(prod.get("category") or "")
    )
    # 品牌：调用方 > 包装上的「品牌/商标」或生产商推断 > 兜底
    raw_brand = str(brand or "").strip() or str(label_info.get("brand") or "").strip() or "识别结果"
    name_confidence = {
        "caller": "high", "label": "high", "label-inferred": "medium", "model": "low", "none": "low",
    }.get(name_source, "low")
    result = {
        "id": "analyze-" + hashlib.md5(
            ((ocr_text or "") + "|" + str(name or "") + "|" + str(brand or "")).encode("utf-8")
        ).hexdigest()[:8],
        "name": raw_name[:40],
        "brand": raw_brand[:20],
        "nameSource": name_source,
        "nameConfidence": name_confidence,
        "labelName": {
            "name": str(label_info.get("name") or "")[:30],
            "brand": str(label_info.get("brand") or "")[:20],
            "maker": str(label_info.get("maker") or "")[:40],
            "source": str(label_info.get("source") or ""),
            "evidence": label_info.get("evidence") or {},
        },
        "spec": (spec or "未标注")[:20],
        "volume": 0,
        "barcode": "未采集",
        "category": str(prod.get("category") or category or "未知品类")[:20],
        "verdict": {
            "level": verdict.get("level") if verdict.get("level") in ("good", "caution", "bad") else "caution",
            "label": str(verdict.get("label") or "需要判断")[:8],
            "why": str(verdict.get("why") or "资料不足，仅按配料表解读")[:120],
        },
        "keys": [
            {"l": str(k.get("l") or "")[:8], "v": str(k.get("v") or "")[:12], "u": str(k.get("u") or "")[:12],
             "hi": bool(k.get("hi"))}
            for k in (data.get("keys") or [])[:3]
        ],
        "ingredients": visible_ingredients,
        "nutrition": [
            {"name": str(n.get("name") or "")[:10], "per100": str(n.get("per100") or "未标注")[:20],
             "whole": str(n.get("whole") or "未标注")[:20], "nrv": int(n.get("nrv") or 0),
             "cm": str(n.get("cm") or "")[:60], "hi": bool(n.get("hi"))}
            for n in (data.get("nutrition") or [])[:6]
        ],
        "equiv": [
            {"big": str(e.get("big") or "")[:16], "small": str(e.get("small") or "")[:24]}
            for e in (data.get("equiv") or [])[:3]
        ],
        "tricks": [
            {"claim": str(t.get("claim") or "")[:20], "ok": bool(t.get("ok")), "edu": bool(t.get("edu")),
             "truth": str(t.get("truth") or "")[:120], "basis": str(t.get("basis") or "")[:80]}
            for t in (data.get("tricks") or [])[:5]
        ],
        "pairs": [
            {"with": str(p.get("with") or "")[:20], "why": str(p.get("why") or "")[:100]}
            for p in (data.get("pairs") or [])[:5]
        ],
        "health": [
            {"tag": str(h.get("tag") or "")[:12], "level": "risk" if h.get("level") == "risk" else "good",
             "text": str(h.get("text") or "")[:100]}
            for h in (data.get("health") or [])[:6]
        ],
        "trace": None,
        "allergens": alg_hits,
        "ocrText": ingredient_text,
    }
    if len(_CACHE) >= 50:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[cache_key] = result
    return result

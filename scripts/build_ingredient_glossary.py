from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "data" / "ingredient_glossary" / "original" / "配料通俗化解释.xlsx"
REVIEW_OUTPUT = ROOT / "data" / "ingredient_glossary" / "glossary.review.json"
REPORT_OUTPUT = ROOT / "data" / "ingredient_glossary" / "build_report.json"
FRONTEND_OUTPUT = ROOT / "app" / "frontend" / "ingredient-glossary.js"
EXPECTED_HEADERS = ["序号", "配料名称", "别名/规范名", "分类", "功能类别", "通俗解释", "常见用途（哪些食品里常见）", "注意事项（谁要注意）", "化学信息", "依据"]
NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

TEXT_OVERRIDES = {
    "脱氢乙酸钠": {
        "what": "抑制霉菌等微生物的防腐剂，使用范围按现行国标食品类别判断。",
        "uses": "腌渍蔬菜、腐乳等现行国标允许类别",
    },
    "丙酸钙": {"what": "丙酸的钙盐，主要用于抑制霉菌，不作为补钙用途。"},
    "甜蜜素": {"what": "高倍甜味剂，少量即可提供明显甜味。"},
    "结晶果糖": {
        "what": "以果糖为主要成分的结晶糖，仍属于糖。",
        "category": "基础配料",
        "role": "甜味原料",
    },
    "果葡糖浆": {
        "what": "淀粉加工得到的葡萄糖和果糖混合糖浆。",
        "category": "基础配料",
        "role": "甜味原料",
    },
    "胭脂虫红": {"uses": "饮料、糖果、肉制品"},
    "黄原胶": {"what": "微生物发酵产生的多糖，用来增稠、减少分层。"},
    "羧甲基纤维素钠": {"what": "纤维素经改性制成的增稠、稳定成分。"},
    "羟丙基甲基纤维素": {"uses": "冰淇淋、烘焙食品"},
    "微晶纤维素": {
        "what": "纤维素制成的微细粉末，可用于增稠、抗结块。",
        "uses": "饮料、乳制品",
    },
    "冰醋酸": {"what": "醋酸类酸度调节成分；冰醋酸是其高浓度形式。"},
    "碳酸氢钠": {"uses": "饼干、馒头、饮料"},
    "食用香精": {"what": "由食用香料等调配的香味成分，不等于果汁或天然原料。"},
    "麦芽糊精": {
        "what": "淀粉部分水解得到的碳水化合物，常用作载体或改善质地。",
        "category": "基础配料",
        "role": "载体/质地改良",
    },
    "聚乙烯醇": {"uses": "糖果包衣"},
    "水": {"what": "食品中的基础原料；排在配料表首位时，通常用量最大。"},
    "橄榄油": {"what": "橄榄果压榨得到的植物油，不同等级适用的烹饪方式不同。"},
    "生牛乳": {"what": "作为乳制品原料的生乳，不能等同于已杀菌的饮用奶。"},
    "蛋白粉": {"what": "蛋白质来源和配方不同的粉状原料，需看具体配料。"},
    "鸡蛋": {"what": "鸡蛋或蛋制品原料，提供蛋白质、脂肪等。"},
    "酱油": {"what": "以大豆等原料发酵制成的咸鲜调味品，具体原料看标签。"},
    "醋": {"what": "以粮食、水果等为原料发酵制成的酸味调味品。"},
    "炼乳": {"what": "牛奶浓缩制成的原料，是否加糖及含糖量看具体产品。"},
    "反式脂肪酸": {
        "what": "脂肪中的一类脂肪酸，标签判断应看营养成分表。",
        "uses": "可能涉及部分氢化油、植脂末等，具体看营养成分表",
    },
    "饱和脂肪酸": {"what": "脂肪酸的一种，摄入情况要结合营养成分和膳食总量。"},
    "添加糖": {"what": "食品加工中额外加入的糖，和游离糖不是完全相同的概念。"},
    "铝": {"what": "可能来自含铝添加剂等的元素，不能仅凭配料名称推算含量。"},
    "亚硝酸盐": {"what": "腌制肉制品中可能涉及的成分，不能由配料表推断实际残留量。"},
    "麸质": {"what": "小麦等谷物中的一类蛋白质，属于过敏原类别，不是单一配料。"},
    "乳": {"what": "乳及乳制品相关类别，用于过敏原提示，不是单一配料。"},
    "蛋类": {"what": "蛋及蛋制品相关类别，用于过敏原提示，不是单一配料。"},
    "花生": {"what": "花生及花生制品相关类别，用于过敏原提示。"},
    "坚果": {"what": "核桃、杏仁、腰果等树坚果类别，用于过敏原提示。"},
    "大豆": {"what": "大豆及豆制品相关类别，用于过敏原提示。"},
    "甲壳类": {"what": "虾、蟹等甲壳类水产类别，用于过敏原提示。"},
}

EXCLUDED_LOOKUP_ALIASES = {
    "亮蓝": {"食用蓝色2号": "不同地区的色素编号体系可能混淆，未核实前不匹配"},
    "结晶果糖": {"果糖": "果糖是泛指，不必然指结晶果糖"},
    "葡萄糖酸-δ-内酯": {"内酯": "内酯是较宽称呼，不能自动锁定这一种成分"},
    "小麦粉": {"面粉": "面粉也可能指其他谷物粉"},
    "生牛乳": {"鲜牛奶": "生牛乳不能直接等同于已杀菌的鲜牛奶"},
    "全脂乳粉": {"奶粉": "奶粉还可能指脱脂或配方乳粉"},
    "黄油": {"牛油": "牛油在不同语境下也可能指牛脂肪"},
    "菜籽油": {"菜油": "菜油在部分地区也可泛指食用油"},
    "酵母": {"活性干酵母": "活性干酵母是具体产品形态，不等同所有酵母"},
    "添加糖": {"游离糖": "游离糖还包括蜂蜜、果汁等来源中的糖"},
}

NUTRITION_NAMES = {"反式脂肪酸", "饱和脂肪酸", "添加糖", "钠", "咖啡因"}
PROCESSING_RELATED_NAMES = {"铝", "亚硝酸盐"}


def q(tag: str) -> str:
    return f"{{{NS}}}{tag}"


def normalize(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).lower().strip()
    text = re.sub(r"^其中[:：]?", "", text)
    text = re.sub(r"[（(][^）)]*[）)]", "", text)
    return re.sub(r"\s+", "", text)


def read_workbook(path: Path) -> list[dict[str, str]]:
    with zipfile.ZipFile(path) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(node.text or "" for node in item.iter(q("t"))) for item in root.findall(q("si"))]
        sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        table = []
        for row in sheet.iter(q("row")):
            values = {}
            for cell in row.findall(q("c")):
                match = re.match(r"[A-Z]+", cell.attrib.get("r", ""))
                if not match:
                    continue
                column = match.group(0)
                kind = cell.attrib.get("t")
                value = cell.find(q("v"))
                inline = cell.find(q("is"))
                if kind == "s" and value is not None:
                    text = shared[int(value.text)]
                elif kind == "inlineStr" and inline is not None:
                    text = "".join(node.text or "" for node in inline.iter(q("t")))
                else:
                    text = value.text if value is not None else ""
                values[column] = text or ""
            table.append([values.get(chr(65 + index), "") for index in range(10)])
    if not table or table[0] != EXPECTED_HEADERS:
        raise ValueError("工作表列名与预期不一致，已停止导入")
    rows = [dict(zip(EXPECTED_HEADERS, values)) for values in table[1:] if any(values)]
    if len(rows) != 143:
        raise ValueError(f"预期 143 条，实际 {len(rows)} 条，已停止导入")
    return rows


def entity_type(name: str, original_category: str, function: str) -> str:
    if function == "过敏原":
        return "allergen"
    if name in NUTRITION_NAMES:
        return "nutrition"
    if name in PROCESSING_RELATED_NAMES:
        return "processing_related"
    if original_category == "食品添加剂" and name not in {"结晶果糖", "果葡糖浆", "麦芽糊精"}:
        return "additive"
    return "ingredient"


def clean_row(row: dict[str, str]) -> dict:
    name = row["配料名称"].strip()
    original_aliases = [] if row["别名/规范名"] in {"", "无"} else [part.strip() for part in row["别名/规范名"].split("/") if part.strip()]
    excluded = EXCLUDED_LOOKUP_ALIASES.get(name, {})
    aliases = [alias for alias in original_aliases if alias not in excluded and normalize(alias) != normalize(name)]
    override = TEXT_OVERRIDES.get(name, {})
    category = override.get("category", row["分类"])
    role = override.get("role", row["功能类别"] if row["功能类别"] != "无" else row["分类"])
    cleaned = {
        "id": int(float(row["序号"])),
        "name": name,
        "entity_type": entity_type(name, row["分类"], row["功能类别"]),
        "category": category,
        "role": role,
        "what": override.get("what", row["通俗解释"]),
        "uses": override.get("uses", row["常见用途（哪些食品里常见）"]),
        "aliases": aliases,
    }
    changes = []
    for output_key, original_key, label in [
        ("what", "通俗解释", "通俗解释"),
        ("uses", "常见用途（哪些食品里常见）", "常见用途"),
        ("category", "分类", "分类"),
        ("role", "功能类别", "功能类别"),
    ]:
        if cleaned[output_key] != row[original_key] and not (output_key == "role" and row[original_key] == "无"):
            changes.append(label)
    return {
        "row": cleaned["id"] + 1,
        "name": name,
        "original": row,
        "cleaned": cleaned,
        "review": {
            "status": "ai_reviewed_identity_and_common_uses",
            "changes": changes,
            "excluded_lookup_aliases": excluded,
            "caution_display": "withheld_no_source_column",
            "evidence_status": "not_provided" if not row["依据"] else "provided_in_source",
        },
    }


def build_lookup(entries: list[dict]) -> dict[str, int]:
    lookup = {}
    for index, entry in enumerate(entries):
        for surface in [entry["name"], *entry["aliases"]]:
            key = normalize(surface)
            if not key:
                continue
            if key in lookup and lookup[key] != index:
                raise ValueError(f"词条匹配冲突：{surface}")
            lookup[key] = index
    return lookup


def javascript(entries: list[dict], lookup: dict[str, int]) -> str:
    payload = json.dumps(entries, ensure_ascii=False, separators=(",", ":"))
    mapping = json.dumps(lookup, ensure_ascii=False, separators=(",", ":"))
    return """(function (root) {
  'use strict';
  var entries = __ENTRIES__;
  var surfaces = __SURFACES__;
  function normalize(value) {
    return String(value || '').normalize('NFKC').toLowerCase().trim()
      .replace(/^其中[:：]?/, '').replace(/[（(][^）)]*[）)]/g, '').replace(/\\s+/g, '');
  }
  function lookup(name) {
    var index = surfaces[normalize(name)];
    return index === undefined ? null : entries[index];
  }
  var api = { entries: entries, lookup: lookup, normalize: normalize };
  root.INGREDIENT_GLOSSARY = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
""".replace("__ENTRIES__", payload).replace("__SURFACES__", mapping)


def main() -> None:
    source = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_SOURCE
    rows = read_workbook(source)
    reviewed = [clean_row(row) for row in rows]
    entries = [item["cleaned"] for item in reviewed]
    lookup = build_lookup(entries)
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    source_name = str(source.relative_to(ROOT)) if source.is_relative_to(ROOT) else str(source)
    review_document = {
        "source": source_name,
        "source_sha256": source_hash,
        "scope": "队友原表全量保留；AI 仅复核名称、别名、分类、通俗解释和常见用途",
        "not_used_for": ["CNN 训练标签", "自动安全结论", "法规许可或限量判断", "个体医疗建议"],
        "entries": reviewed,
    }
    report = {
        "source": source_name,
        "source_sha256": source_hash,
        "rows": len(entries),
        "entity_types": dict(sorted(Counter(entry["entity_type"] for entry in entries).items())),
        "lookup_surfaces": len(lookup),
        "lookup_aliases": len(lookup) - len(entries),
        "rows_with_text_or_category_corrections": sum(bool(item["review"]["changes"]) for item in reviewed),
        "rows_with_excluded_aliases": sum(bool(item["review"]["excluded_lookup_aliases"]) for item in reviewed),
        "cautions_withheld": sum(item["review"]["caution_display"] == "withheld_no_source_column" for item in reviewed),
        "blank_chemical_information": sum(not row["化学信息"] for row in rows),
        "blank_evidence": sum(not row["依据"] for row in rows),
    }
    REVIEW_OUTPUT.write_text(json.dumps(review_document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    REPORT_OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    FRONTEND_OUTPUT.write_text(javascript(entries, lookup), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

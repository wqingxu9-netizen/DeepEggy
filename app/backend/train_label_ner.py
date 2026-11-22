"""训练包装字段抽取基线。数据是合成银标，不是真实包装真值，不得用于溯源结论。

用法：python -m app.backend.train_label_ner --train-size 1600 --dev-size 400 --test-size 600 --epochs 8
"""

from __future__ import annotations

import argparse
import json
import random
import time
from collections import Counter
from pathlib import Path

from .label_ner import FIELDS, evaluate, train

STEMS = {
    "train": ["青禾", "山泉", "麦田", "晨曦", "佳品", "原野", "金谷", "林海", "禾香", "绿洲", "百味", "丰年", "云岭", "同心", "康源", "谷力", "鲜达", "纯正", "天禾", "惠农"],
    "dev": ["星澜", "沐川", "谷韵", "澄露", "沁源", "鹿鸣", "森野", "禾木", "瑞禾", "岳川", "初露", "丰泽"],
    "test": ["朔原", "南屿", "青岑", "谷川", "禾悦", "云牧", "田笙", "溪谷", "木禾", "川露", "金穗", "清嵘"],
}
REGIONS = {
    "train": [("四川省", "成都市", "邛崃市"), ("广东省", "佛山市", "高明区"), ("山东省", "青岛市", "即墨区"), ("河南省", "郑州市", "中牟县"), ("黑龙江省", "哈尔滨市", "双城区"), ("内蒙古自治区", "呼和浩特市", "和林格尔县"), ("安徽省", "合肥市", "肥西县"), ("江苏省", "苏州市", "吴中区"), ("浙江省", "杭州市", "萧山区"), ("广西壮族自治区", "南宁市", "武鸣区")],
    "dev": [("福建省", "泉州市", "晋江市"), ("湖北省", "宜昌市", "夷陵区"), ("湖南省", "湘潭市", "湘潭县"), ("河北省", "保定市", "竞秀区"), ("江西省", "赣州市", "南康区"), ("辽宁省", "大连市", "金州区")],
    "test": [("吉林省", "长春市", "九台区"), ("山西省", "运城市", "盐湖区"), ("重庆市", "重庆市", "江津区"), ("贵州省", "遵义市", "播州区"), ("甘肃省", "兰州市", "榆中县"), ("海南省", "海口市", "秀英区")],
}
INDUSTRIES = ["食品饮料", "食品", "饮品", "乳业", "调味品", "粮油", "农产品"]
ROADS = ["工业园区", "高新技术产业开发区", "食品产业园", "经济开发区", "振兴大道", "兴业路", "和平街", "创业路"]
INGREDIENTS = ["水、白砂糖、柠檬酸、食用香精", "水、全脂乳粉、白砂糖、乳酸菌", "小麦粉、饮用水、食用盐、酵母", "水、果葡糖浆、浓缩苹果汁、维生素C"]
KEYS = {
    "producer": ["生产商", "生产企业", "制造商", "受委托生产商"],
    "address": ["厂址", "生产地址", "地址"],
    "std_no": ["产品标准号", "执行标准"],
    "sc_code": ["生产许可证编号", "食品生产许可证号"],
}


def company_value(split: str, rng: random.Random) -> str:
    stem = rng.choice(STEMS[split])
    province, city, district = rng.choice(REGIONS[split])
    industry = rng.choice(INDUSTRIES)
    pattern = rng.randrange(4)
    if pattern == 0:
        return f"{city}{stem}{industry}有限公司"
    if pattern == 1:
        return f"{stem}（{city.removesuffix('市')}）{industry}有限公司"
    if pattern == 2:
        return f"{stem}{industry}（{city}）股份有限公司"
    return f"{province}{city}{stem}食品厂"


def address_value(split: str, rng: random.Random) -> str:
    province, city, district = rng.choice(REGIONS[split])
    road = rng.choice(ROADS)
    if rng.random() < 0.45:
        return f"{province}{city}{district}{road}"
    return f"{province}{city}{district}{road}{rng.randrange(1, 299)}号"


def std_value(split: str, rng: random.Random) -> str:
    prefix = rng.choice(["GB", "GB/T"])
    low, high = {"train": (1000, 6000), "dev": (6000, 8000), "test": (8000, 10000)}[split]
    number = str(rng.randrange(low, high))
    if rng.random() < 0.22:
        number += f".{rng.randrange(1, 5)}"
    year = f"-{rng.randrange(2000, 2026)}" if rng.random() < 0.8 else ""
    space = " " if rng.random() < 0.65 else ""
    return f"{prefix}{space}{number}{year}"


def sc_value(rng: random.Random) -> str:
    return "SC" + "".join(str(rng.randrange(10)) for _ in range(14))


def noisy_value(field: str, value: str, rng: random.Random) -> str:
    if field == "std_no":
        value = value.replace("GB/T", rng.choice(["GB / T", "GB/ T", "GB /T"]))
        if rng.random() < 0.35:
            value = value.replace("-", " - ")
    elif field == "sc_code" and rng.random() < 0.45:
        value = "SC " + value[2:]
    elif field in ("producer", "address") and rng.random() < 0.18:
        pos = rng.randrange(2, max(3, len(value) - 2))
        value = value[:pos] + " " + value[pos:]
    return value


def make_document(split: str, index: int, rng: random.Random) -> dict:
    noisy = rng.random() < (0.35 if split == "train" else 0.4)
    if split == "train":
        layout = rng.randrange(5)
    elif rng.random() < 0.2:
        layout = rng.choice([5, 6])
    else:
        layout = rng.randrange(5)
    values = {
        "producer": company_value(split, rng),
        "address": address_value(split, rng),
        "std_no": std_value(split, rng),
        "sc_code": sc_value(rng),
    }
    fields = [field for field in FIELDS if field == "producer" or rng.random() > 0.08]
    rng.shuffle(fields)
    text_parts: list[str] = []
    entities: list[dict] = []

    def raw(value: str) -> None:
        text_parts.append(value)

    def entity(field: str, value: str) -> None:
        start = sum(len(part) for part in text_parts)
        text_parts.append(value)
        entities.append({"field": field, "start": start, "end": start + len(value), "value": value})

    stem = rng.choice(STEMS[split])
    raw(f"产品名称：{stem}示例食品\n净含量：500毫升\n")
    for field in fields:
        key = rng.choice(KEYS[field])
        value = noisy_value(field, values[field], rng) if noisy else values[field]
        if layout == 0:
            prefix, suffix = f"{key}：", "\n"
        elif layout == 1:
            prefix, suffix = f"{key}：", " "
        elif layout == 2:
            prefix, suffix = f"【{key}】", " | "
        elif layout == 3:
            prefix, suffix = f"{key}：", "；"
        elif layout == 4:
            prefix, suffix = f"{key} ", "\n"
        elif layout == 5:
            prefix, suffix = f"{key}=", "；"
        else:
            prefix, suffix = " ".join(key) + "：", "\n"
        if noisy and rng.random() < 0.12:
            prefix = prefix.replace("：", ":").replace("【", "").replace("】", "")
        raw(prefix)
        entity(field, value)
        raw(suffix)
    raw(f"\n配料表：{rng.choice(INGREDIENTS)}\n营养成分：每100克能量{rng.randrange(100, 500)}千焦")
    slice_name = "unseen_layout" if layout >= 5 else ("ocr_noise" if noisy else "unseen_entity")
    return {
        "id": f"synthetic-{split}-{index:06d}",
        "split": split,
        "slice": slice_name,
        "synthetic": True,
        "silver_labels": True,
        "real_photo": False,
        "layout": layout,
        "text": "".join(text_parts),
        "entities": entities,
    }


def generate(split: str, size: int, seed: int) -> list[dict]:
    rng = random.Random(seed + {"train": 0, "dev": 1000, "test": 2000}[split])
    return [make_document(split, i, rng) for i in range(size)]


def write_jsonl(path: Path, documents: list[dict]) -> None:
    path.write_text("".join(json.dumps(doc, ensure_ascii=False) + "\n" for doc in documents), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train-size", type=int, default=1600)
    parser.add_argument("--dev-size", type=int, default=400)
    parser.add_argument("--test-size", type=int, default=600)
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20261121)
    parser.add_argument("--data-dir", type=Path, default=Path("data/training"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/models"))
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    documents = {
        "train": generate("train", args.train_size, args.seed),
        "dev": generate("dev", args.dev_size, args.seed),
        "test": generate("test", args.test_size, args.seed),
    }
    for split, rows in documents.items():
        write_jsonl(args.data_dir / f"label_ner_{split}.jsonl", rows)

    entity_sets = {
        split: {entity["value"] for doc in rows for entity in doc["entities"]}
        for split, rows in documents.items()
    }
    overlap = {
        f"{left}_{right}": len(entity_sets[left] & entity_sets[right])
        for left, right in (("train", "dev"), ("train", "test"), ("dev", "test"))
    }
    if any(overlap.values()):
        raise RuntimeError(f"数据集存在实体泄漏：{overlap}")

    info = {
        "warning": "全部为模板生成的合成银标，真实包装照片数为 0；指标不能表述为真实商品识别准确率。",
        "seed": args.seed,
        "fields": FIELDS,
        "counts": {split: len(rows) for split, rows in documents.items()},
        "slices": {split: dict(Counter(doc["slice"] for doc in rows)) for split, rows in documents.items()},
        "entity_value_overlap": overlap,
        "real_photo_count": 0,
        "used_for_trace_evidence": False,
    }
    (args.data_dir / "dataset_info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")

    started = time.time()
    model, history = train(documents["train"], documents["dev"], epochs=args.epochs, seed=args.seed)
    test_result = evaluate(model, documents["test"])
    by_slice = {
        name: evaluate(model, [doc for doc in documents["test"] if doc["slice"] == name])
        for name in sorted({doc["slice"] for doc in documents["test"]})
    }
    metadata = {
        **info,
        "best_epoch": model.best_epoch,
        "epochs": args.epochs,
        "elapsed_seconds": round(time.time() - started, 2),
    }
    model_path = args.output_dir / "label_ner_model.json"
    model.save(model_path, metadata)
    metrics = {
        **metadata,
        "history": history,
        "test": test_result,
        "test_by_slice": by_slice,
        "model_bytes": model_path.stat().st_size,
    }
    (args.output_dir / "label_ner_metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "warning": info["warning"], "best_epoch": model.best_epoch,
        "elapsed_seconds": metadata["elapsed_seconds"], "model_bytes": metrics["model_bytes"],
        "test_micro": test_result["micro"], "document_exact_rate": test_result["document_exact_rate"],
        "by_slice": {name: result["micro"]["f1"] for name, result in by_slice.items()},
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

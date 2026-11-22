"""轻量包装字段序列标注：纯标准库平均感知机，不接入溯源证据链。"""

from __future__ import annotations

import json
import random
import re
from collections import defaultdict
from pathlib import Path

FIELDS = ("producer", "address", "std_no", "sc_code")
LABELS = ("O",) + tuple(f"{prefix}-{field}" for field in FIELDS for prefix in ("B", "I"))
KEYWORDS = (
    "受委托生产商", "生产许可证编号", "食品生产许可证号", "产品标准号",
    "生产加工企业", "生产企业", "生产商", "制造商", "生产地址", "生产地",
    "执行标准", "标准号", "生产许可", "厂址", "地址", "SC",
)


def char_shape(char: str) -> str:
    if char.isdigit():
        return "D"
    if "A" <= char <= "Z" or "a" <= char <= "z":
        return "A"
    if "一" <= char <= "鿿":
        return "C"
    if char.isspace():
        return "_"
    return char


def features(text: str, i: int, previous_tag: str = "O") -> list[str]:
    out = ["bias", f"prev={previous_tag}", f"prev|shape={previous_tag}|{char_shape(text[i])}"]
    size = len(text)
    for offset in (-3, -2, -1, 0, 1, 2, 3):
        j = i + offset
        if 0 <= j < size:
            out.append(f"c{offset}={text[j]}")
            out.append(f"s{offset}={char_shape(text[j])}")
        else:
            out.append(f"c{offset}=<PAD>")
    for offset in (-2, -1, 0):
        j = i + offset
        if 0 <= j and j + 1 < size:
            out.append(f"b{offset}={text[j:j + 2]}")
    out.append(f"tri={text[max(0, i - 1):i + 2]}")
    out.append("win=" + "".join(char_shape(c) for c in text[max(0, i - 2):i + 3]))
    # OCR 会把「生产商」识别成「生 产 商」；关键词特征忽略空白，但实体边界仍按原文计算。
    prefix = re.sub(r"\s+", "", text[max(0, i - 24):i])
    for keyword in KEYWORDS:
        pos = prefix.rfind(keyword)
        if pos >= 0:
            distance = len(prefix) - pos - len(keyword)
            out.append(f"kw={keyword}@{min(distance, 9)}")
    if i == 0 or text[i - 1] == "\n":
        out.append("line_start")
    if i > 0 and text[i - 1] in "：:=":
        out.append("after_colon")
    return out


def tags_for(text: str, entities: list[dict]) -> list[str]:
    tags = ["O"] * len(text)
    for entity in entities:
        start, end = entity["start"], entity["end"]
        if not (0 <= start < end <= len(text)) or text[start:end] != entity["value"]:
            raise ValueError(f"实体边界与文本不一致：{entity}")
        tags[start] = f"B-{entity['field']}"
        for i in range(start + 1, end):
            tags[i] = f"I-{entity['field']}"
    return tags


def spans_from_tags(text: str, tags: list[str]) -> list[dict]:
    entities: list[dict] = []
    start: int | None = None
    field = ""

    def close(end: int) -> None:
        nonlocal start, field
        if start is not None:
            entities.append({"field": field, "start": start, "end": end, "value": text[start:end]})
        start, field = None, ""

    for i, tag in enumerate([*tags, "O"]):
        match = re.fullmatch(r"([BI])-(.+)", tag) if tag != "O" else None
        if not match:
            close(i)
            continue
        prefix, next_field = match.groups()
        if prefix == "B" or next_field != field or start is None:
            close(i)
            start, field = i, next_field
    return entities


class AveragedPerceptronTagger:
    def __init__(self, weights: dict | None = None):
        self.weights = weights or {}
        self.steps = 0
        self._totals: dict[tuple[str, str], float] = defaultdict(float)
        self._timestamps: dict[tuple[str, str], int] = defaultdict(int)

    def predict_tag(self, text: str, i: int, previous_tag: str = "O") -> str:
        scores = dict.fromkeys(LABELS, 0.0)
        for feature in features(text, i, previous_tag):
            for label, weight in self.weights.get(feature, {}).items():
                scores[label] += weight
        return max(LABELS, key=lambda label: scores[label])

    def predict(self, text: str) -> list[dict]:
        tags: list[str] = []
        for i in range(len(text)):
            tags.append(self.predict_tag(text, i, tags[-1] if tags else "O"))
        return spans_from_tags(text, tags)

    def _update(self, feature: str, label: str, change: float) -> None:
        key = (feature, label)
        current = self.weights.get(feature, {}).get(label, 0.0)
        self._totals[key] += (self.steps - self._timestamps[key]) * current
        self._timestamps[key] = self.steps
        row = self.weights.setdefault(feature, {})
        row[label] = current + change

    def train_one(self, document: dict) -> int:
        text = document["text"]
        gold_tags = tags_for(text, document["entities"])
        mistakes = 0
        previous_tag = "O"
        for i, gold in enumerate(gold_tags):
            self.steps += 1
            predicted = self.predict_tag(text, i, previous_tag)
            if predicted != gold:
                mistakes += 1
                for feature in features(text, i, previous_tag):
                    self._update(feature, gold, 1.0)
                    self._update(feature, predicted, -1.0)
            previous_tag = predicted
        return mistakes

    def averaged_weights(self) -> dict[str, dict[str, float]]:
        if not self.steps:
            return {}
        averaged: dict[str, dict[str, float]] = {}
        for feature, row in self.weights.items():
            target: dict[str, float] = {}
            for label, weight in row.items():
                key = (feature, label)
                total = self._totals[key] + (self.steps - self._timestamps[key]) * weight
                value = total / self.steps
                if abs(value) > 1e-8:
                    target[label] = round(value, 8)
            if target:
                averaged[feature] = target
        return averaged

    def save(self, path: str | Path, metadata: dict) -> None:
        payload = {
            "format": "averaged_perceptron_char_tagger_v2",
            "labels": LABELS,
            "fields": FIELDS,
            "metadata": metadata,
            "weights": self.averaged_weights(),
        }
        Path(path).write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path) -> "AveragedPerceptronTagger":
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        if payload.get("format") != "averaged_perceptron_char_tagger_v2":
            raise ValueError("未知模型格式")
        return cls(payload["weights"])


def evaluate(model: AveragedPerceptronTagger, documents: list[dict]) -> dict:
    counts = {field: {"tp": 0, "pred": 0, "gold": 0} for field in FIELDS}
    exact_documents = 0
    failures: list[dict] = []
    for document in documents:
        predicted = model.predict(document["text"])
        gold = document["entities"]
        gold_keys = {(e["field"], e["start"], e["end"]) for e in gold}
        pred_keys = {(e["field"], e["start"], e["end"]) for e in predicted}
        exact_documents += int(gold_keys == pred_keys)
        for field in FIELDS:
            g = {(e["start"], e["end"]) for e in gold if e["field"] == field}
            p = {(e["start"], e["end"]) for e in predicted if e["field"] == field}
            counts[field]["tp"] += len(g & p)
            counts[field]["pred"] += len(p)
            counts[field]["gold"] += len(g)
        if gold_keys != pred_keys and len(failures) < 8:
            failures.append({
                "id": document["id"], "slice": document["slice"], "text": document["text"],
                "gold": gold, "predicted": predicted,
            })

    def metrics(tp: int, pred: int, gold: int) -> dict:
        precision = tp / pred if pred else 0.0
        recall = tp / gold if gold else 0.0
        return {
            "tp": tp, "predicted": pred, "gold": gold,
            "precision": round(precision, 4), "recall": round(recall, 4),
            "f1": round(2 * precision * recall / (precision + recall), 4) if precision + recall else 0.0,
        }

    by_field = {field: metrics(**values) for field, values in counts.items()}
    total = {key: sum(values[key] for values in counts.values()) for key in ("tp", "pred", "gold")}
    return {
        "documents": len(documents),
        "document_exact_rate": round(exact_documents / len(documents), 4) if documents else 0.0,
        "micro": metrics(**total),
        "by_field": by_field,
        "failures": failures,
    }


def train(
    train_documents: list[dict],
    dev_documents: list[dict],
    epochs: int = 8,
    seed: int = 20261121,
) -> tuple[AveragedPerceptronTagger, list[dict]]:
    model = AveragedPerceptronTagger()
    history: list[dict] = []
    best_f1 = -1.0
    best_weights: dict = {}
    best_epoch = 0
    for epoch in range(1, epochs + 1):
        shuffled = list(train_documents)
        random.Random(seed + epoch).shuffle(shuffled)
        mistakes = sum(model.train_one(document) for document in shuffled)
        snapshot = AveragedPerceptronTagger(model.averaged_weights())
        dev_result = evaluate(snapshot, dev_documents)
        history.append({
            "epoch": epoch, "train_character_mistakes": mistakes,
            "dev_micro_f1": dev_result["micro"]["f1"],
            "dev_document_exact_rate": dev_result["document_exact_rate"],
        })
        if dev_result["micro"]["f1"] > best_f1:
            best_f1 = dev_result["micro"]["f1"]
            best_weights = snapshot.weights
            best_epoch = epoch
    best = AveragedPerceptronTagger(best_weights)
    best.steps = model.steps
    best.best_epoch = best_epoch
    return best, history

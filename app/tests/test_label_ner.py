"""字段抽取基线测试：全部使用合成数据，不联网、不读取真实商品。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.backend.label_ner import AveragedPerceptronTagger, evaluate, spans_from_tags, tags_for, train
from app.backend.train_label_ner import generate


class TestLabelNer(unittest.TestCase):
    def test_tags_roundtrip(self):
        text = "生产商：示例食品有限公司\n产品标准号：GB 1234-2025"
        producer_start = text.index("示例食品有限公司")
        std_start = text.index("GB 1234-2025")
        entities = [
            {"field": "producer", "start": producer_start, "end": producer_start + 8, "value": "示例食品有限公司"},
            {"field": "std_no", "start": std_start, "end": std_start + 12, "value": "GB 1234-2025"},
        ]
        self.assertEqual(text[producer_start:producer_start + 8], "示例食品有限公司")
        self.assertEqual(text[std_start:std_start + 12], "GB 1234-2025")
        self.assertEqual(spans_from_tags(text, tags_for(text, entities)), entities)

    def test_split_has_no_entity_value_overlap(self):
        train_docs = generate("train", 20, 123)
        test_docs = generate("test", 20, 123)
        train_values = {e["value"] for d in train_docs for e in d["entities"]}
        test_values = {e["value"] for d in test_docs for e in d["entities"]}
        self.assertFalse(train_values & test_values)
        self.assertTrue(all(d["synthetic"] and not d["real_photo"] for d in train_docs + test_docs))

    def test_training_and_model_roundtrip(self):
        train_docs = generate("train", 40, 123)
        dev_docs = generate("dev", 12, 123)
        model, history = train(train_docs, dev_docs, epochs=3, seed=123)
        self.assertEqual(len(history), 3)
        self.assertGreater(evaluate(model, train_docs)["micro"]["f1"], 0.75)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.json"
            model.save(path, {"synthetic_only": True})
            loaded = AveragedPerceptronTagger.load(path)
            text = train_docs[0]["text"]
            self.assertEqual(loaded.predict(text), model.predict(text))


if __name__ == "__main__":
    unittest.main()

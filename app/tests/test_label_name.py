"""包装 OCR 文本 → 商品名 / 品牌（拍配料表时的品名识别）"""
import json
import unittest
from unittest.mock import patch

from app.backend import analyze, label_name
from app.backend.analyze import choose_name

FAKE_MODEL_JSON = json.dumps({
    "product": {"name": "含乳饮料", "category": "乳饮料"},
    "verdict": {"level": "caution", "label": "适量更合适", "why": "糖不低"},
    "keys": [],
    "ingredients": [{"name": "水", "flag": "green", "role": "主体", "what": "就是水"}],
    "nutrition": [], "equiv": [], "tricks": [], "pairs": [], "health": [],
}, ensure_ascii=False)


class LabelNameTests(unittest.TestCase):
    def test_field_form_on_one_line(self):
        info = label_name.extract("品名：阿萨姆奶茶 净含量：500ml 配料表：水、白砂糖、全脂乳粉")
        self.assertEqual(info["name"], "阿萨姆奶茶")
        self.assertEqual(info["source"], "field")
        self.assertEqual(info["confidence"], "high")

    def test_field_and_value_on_separate_ocr_rows(self):
        info = label_name.extract("统一阿萨姆奶茶\n原味\n产品名称\n阿萨姆奶茶 原味\n配料表：水、白砂糖")
        self.assertEqual(info["name"], "阿萨姆奶茶 原味")
        self.assertEqual(info["confidence"], "high")

    def test_name_line_without_field(self):
        info = label_name.extract(
            "统一阿萨姆奶茶 原味 配料表：水、白砂糖、全脂乳粉 产品标准号：GB/T 21732 "
            "生产商：统一企业（中国）投资有限公司 厂址：安徽省滁州市"
        )
        self.assertIn("阿萨姆奶茶", info["name"])
        self.assertEqual(info["source"], "line")
        self.assertEqual(info["confidence"], "medium")

    def test_no_name_on_label_returns_empty_instead_of_guessing(self):
        info = label_name.extract(
            "配料表：水、白砂糖、果葡糖浆、柠檬酸 产品标准号：GB 7101 "
            "生产商：达能（中国）食品饮料有限公司 厂址：四川省成都市"
        )
        self.assertEqual(info["name"], "")
        self.assertEqual(info["confidence"], "none")

    def test_noise_lines_are_not_taken_as_name(self):
        for text in (
            "净含量：500ml 配料表：水、白砂糖",
            "产品标准号：GB 7101 配料表：水、白砂糖",
            "保质期：12 个月 配料表：水、白砂糖",
            "SC10632012345678 配料表：水、白砂糖",
        ):
            self.assertEqual(label_name.extract(text)["name"], "", text)

    def test_brand_field_and_maker_derivation(self):
        with_brand = label_name.extract("品牌：元气森林 品名：白桃味气泡水 配料表：水、二氧化碳")
        self.assertEqual(with_brand["brand"], "元气森林")
        self.assertEqual(with_brand["name"], "白桃味气泡水")

        derived = label_name.extract("配料表：水、生牛乳 生产商：统一企业（中国）投资有限公司")
        self.assertEqual(derived["brand"], "统一")
        self.assertEqual(derived["maker"], "统一企业（中国）投资有限公司")

    def test_prefix_is_only_searched_before_ingredients(self):
        # 「厂址：某某食品有限公司」出现在配料之后，不能被当作品名或品牌来源
        info = label_name.extract(
            "配料表：水、白砂糖、柠檬酸 厂址：某某食品有限公司 生产商：某某食品有限公司"
        )
        self.assertEqual(info["name"], "")

    def test_empty_text(self):
        for value in ("", None, "   "):
            self.assertEqual(label_name.extract(value)["name"], "")

    def test_oem_label_takes_brand_from_supervisor_not_consignor(self):
        # 真实包装：委托方是代工厂（安徽陆勤），品牌其实是「安勤」，出现在监制方里
        text = (
            "TACTICALS\n产品名称：安勤®90压缩干粮\n产品类型：压缩饼干\n"
            "配料：小麦粉、植物油、白砂糖、饮用水、食用葡萄糖、全脂乳粉、食用盐、"
            "碳酸氢钠(膨松剂)、维生素B₁(盐酸硫胺素)、维生素B₂(核黄素)\n"
            "产品执行标准号：GB/T20980\n"
            "委托方：安徽陆勤食品研发有限公司\n"
            "受托方：安徽美旗城食品有限公司\n"
            "监制方：北京市安勤应急食品开发有限公司\n"
            "生产日期：2026/08/01\n"
        )
        info = label_name.extract(text)
        self.assertEqual(info["name"], "安勤90压缩干粮")
        self.assertEqual(info["brand"], "安勤")
        self.assertEqual(info["confidence"], "high")


class NamePriorityTests(unittest.TestCase):
    def test_priority_order(self):
        self.assertEqual(choose_name("脉动 水蜜桃", {}, "含乳饮料", "饮料"), ("脉动 水蜜桃", "caller"))
        self.assertEqual(choose_name("", {"name": "阿萨姆奶茶", "confidence": "high"}, "含乳饮料", "饮料"),
                         ("阿萨姆奶茶", "label"))
        self.assertEqual(choose_name("", {"name": "阿萨姆奶茶", "confidence": "medium"}, "", ""),
                         ("阿萨姆奶茶", "label-inferred"))
        self.assertEqual(choose_name("", {"name": ""}, "含乳饮料", "饮料"), ("含乳饮料", "model"))
        self.assertEqual(choose_name("", {}, "未知产品", "含乳饮料"), ("含乳饮料（按配料判断）", "none"))
        self.assertEqual(choose_name("", {}, "", ""), ("未命名商品", "none"))

    def test_label_photo_takes_name_and_brand_from_package(self):
        text = ("品名：阿萨姆奶茶 净含量：500ml 配料表：水、白砂糖、全脂乳粉、红茶 产品标准号：GB/T 21732 "
                "生产商：统一企业（中国）投资有限公司 厂址：安徽省滁州市")
        with patch.object(analyze, "API_KEY", "test-key"), \
                patch.object(analyze, "_call_llm", return_value=FAKE_MODEL_JSON):
            result = analyze.analyze(text)
        self.assertEqual(result["name"], "阿萨姆奶茶")
        self.assertEqual(result["nameSource"], "label")
        self.assertEqual(result["brand"], "统一")
        self.assertEqual(result["labelName"]["source"], "field")

    def test_label_without_name_falls_back_and_says_so(self):
        text = ("配料表：水、生牛乳、白砂糖 产品标准号：GB 7101 "
                "生产商：某某食品有限公司 厂址：某某市")
        with patch.object(analyze, "API_KEY", "test-key"), \
                patch.object(analyze, "_call_llm", return_value=FAKE_MODEL_JSON):
            result = analyze.analyze(text)
        # 包装上没品名 → 用模型的判断，并标记来源，前端会提示「品名由 AI 判断」
        self.assertEqual(result["name"], "含乳饮料")
        self.assertEqual(result["nameSource"], "model")
        self.assertEqual(result["labelName"]["name"], "")


if __name__ == "__main__":
    unittest.main(verbosity=2)

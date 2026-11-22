"""Regression tests for OCR ingredient-section extraction and local matching."""

import unittest

from app.backend.analyze import extract_ingredient_text, normalize_ingredients


class TestIngredientExtraction(unittest.TestCase):
    def test_keeps_only_lines_between_ingredient_and_next_label(self):
        text = (
            "产品类型：夹心糕点\n"
            "配料：鸡蛋、白砂糖、小麦粉、麦芽糖浆、起酥油\n"
            "水、精炼植物油、山梨酸钾、碳酸氢钠\n"
            "致敏物质提示：含有小麦和乳制品\n"
            "产品标准代号：Q/DLJT100S\n营养成分表"
        )
        self.assertEqual(
            extract_ingredient_text(text),
            "鸡蛋、白砂糖、小麦粉、麦芽糖浆、起酥油水、精炼植物油、山梨酸钾、碳酸氢钠",
        )
        self.assertEqual(
            normalize_ingredients(text),
            ["鸡蛋", "白砂糖", "小麦粉", "麦芽糖浆", "起酥油", "水", "植物油", "山梨酸钾", "碳酸氢钠"],
            # 208 条词条里「精炼植物油」是「植物油」的别名，归一到词条名「植物油」
        )

    def test_does_not_guess_short_words(self):
        self.assertEqual(normalize_ingredients("配料表：鸡蛋、山梨酸钾、碳酸氢钠"), ["鸡蛋", "山梨酸钾", "碳酸氢钠"])
        self.assertEqual(normalize_ingredients("配料：梨、未知原料"), ["梨", "未知原料"])

    def test_brackets_are_unwrapped_or_dropped_by_their_shape(self):
        # 括号里有顿号 = 复合配料/分组，拆开；括号里只有一项 = 备注，整段丢掉
        self.assertEqual(
            normalize_ingredients("配料：水、植脂末（葡萄糖浆、植物油）、乳清粉（含乳清蛋白≥35%）"),
            ["水", "植脂末", "葡萄糖浆", "植物油", "乳清粉"],
        )
        self.assertEqual(
            normalize_ingredients("配料：小麦粉、碳酸氢钠(膨松剂)、维生素B₁(盐酸硫胺素)"),
            ["小麦粉", "碳酸氢钠", "维生素B₁"],
        )
        self.assertEqual(
            normalize_ingredients("配料：水、食品添加剂（柠檬酸、柠檬酸钠）、食用香精"),
            ["水", "柠檬酸", "柠檬酸钠", "食用香精"],
        )


if __name__ == "__main__":
    unittest.main()

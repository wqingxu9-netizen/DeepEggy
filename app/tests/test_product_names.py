"""商品名规范化测试：索引里只许出现「哪个品牌 + 具体哪款食品」。

背景（2026-11-22 团队截图指出）：首页商品索引里混进了「卡尔蔡司镜头清洁湿巾」，
还有「伊利」「冰露」这种只写品牌的条目——名字里没有「是什么东西」。
这里把这几条钉成回归测试。

跑法：项目根目录 `python -m unittest discover -s app/tests -t .`
"""

from __future__ import annotations

import unittest

from app.backend import product_names as pn


class TestNonFood(unittest.TestCase):
    def test_lens_wipe_rejected(self):
        # OFF 是众包库，镜头清洁湿巾也有条码，必须有词表挡掉
        self.assertFalse(pn.usable("0662834503593", "卡尔蔡司镜头清洁湿巾", "卡尔蔡司, 蔡司", ""))

    def test_balm_rejected(self):
        self.assertFalse(pn.usable("1", "虎牌万金油", "虎牌", ""))

    def test_english_only_rejected(self):
        self.assertFalse(pn.usable("6901939621738", "Schweppes Soda Water (Sugar-Free)", "Schweppes", "Sodas"))

    def test_broken_name_rejected(self):
        self.assertFalse(pn.usable("2", "??奶片", "??奶片", "奶"))


class TestBrandOnly(unittest.TestCase):
    """只写品牌名的条目：要么补出具体品名，要么整条不进索引。"""

    def test_bare_brand_gets_product_from_categories(self):
        cat = "奶, 全脂灭菌纯牛奶, 牛奶"
        self.assertTrue(pn.usable("6907992100272", "伊利", "", cat))
        self.assertEqual(pn.display("6907992100272", "伊利", "", cat),
                         ("伊利 全脂灭菌纯牛奶", "伊利"))

    def test_bare_brand_without_category_dropped(self):
        self.assertFalse(pn.usable("3", "伊利", "", ""))
        self.assertFalse(pn.usable("3", "冰露", "Coca-Cola", ""))

    def test_bare_brand_with_foreign_company_dropped(self):
        # 品牌栏只有外文，品类也补不出东西 → 说不清是哪一款
        self.assertFalse(pn.usable("4", "红牛", "Red Bull", ""))


class TestGenericName(unittest.TestCase):
    def test_generic_without_subject_dropped(self):
        self.assertFalse(pn.usable("5", "纯牛奶", "", "Milk"))

    def test_generic_with_series_prefixed(self):
        self.assertEqual(pn.display("5", "纯牛奶", "特仑苏, 蒙牛", "奶"),
                         ("特仑苏 纯牛奶", "蒙牛"))

    def test_short_name_prefixed_by_brand(self):
        self.assertEqual(pn.display("6920152460061", "红烧牛肉面", "Master Kong, 康师傅", "方便面"),
                         ("康师傅 红烧牛肉面", "康师傅"))

    def test_name_already_has_brand_untouched(self):
        self.assertEqual(pn.display("6922255451427", "百岁山 饮用天然矿泉水", "Ganten, 百岁山", "天然矿泉水"),
                         ("百岁山 饮用天然矿泉水", "百岁山"))


class TestProductIndex(unittest.TestCase):
    """真数据：整份索引过一遍，保证首页不会再出现截图里那几行。"""

    @classmethod
    def setUpClass(cls):
        from app.backend import main as backend

        cls.items = backend._get_product_index()
        cls.by_code = {i["code"]: i for i in cls.items}

    def test_index_not_empty(self):
        self.assertGreater(len(self.items), 300)

    def test_lens_wipe_not_indexed(self):
        self.assertNotIn("0662834503593", self.by_code)

    def test_brand_only_row_now_has_product(self):
        row = self.by_code.get("6907992100272")
        self.assertIsNotNone(row, "「伊利」应该补成品名后留在索引里")
        self.assertEqual(row["name"], "伊利 全脂灭菌纯牛奶")
        self.assertIn("牛奶", row["name"])

    def test_no_non_food_keywords(self):
        bad = [i["name"] for i in self.items if any(w in i["name"] for w in pn._BLOCK_WORDS)]
        self.assertEqual(bad, [])

    def test_every_off_row_says_what_it_is(self):
        # extra-xxx 是商品页抓的整句商品名，不做词表判断
        bad = [i["name"] for i in self.items
               if not str(i["code"]).startswith("extra-") and not pn._has_product_noun(i["name"])]
        self.assertEqual(bad, [])

    def test_no_english_only_names(self):
        bad = [i["name"] for i in self.items if not pn._CJK.search(i["name"])]
        self.assertEqual(bad, [])


if __name__ == "__main__":
    unittest.main()

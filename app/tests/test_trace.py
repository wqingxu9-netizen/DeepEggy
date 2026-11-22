"""溯源层测试：不联网，只验「不许编造」这条底线与解析器。

跑法：cd 项目根目录后 `python -m unittest discover -s app/tests -t .`（只用标准库）
"""

from __future__ import annotations

import unittest

from app.backend.trace import _clean_field, _parse_baidu, build_trace, ev, normalize

DEMO_OCR = (
    "配料表：水、白砂糖、果葡糖浆、柠檬酸、食用香精、维生素C、烟酰胺 "
    "产品标准号：GB 7101 生产许可证编号：SC10651018300188 "
    "生产商：达能（中国）食品饮料有限公司 厂址：四川省成都市邛崃市工业园区 "
    "产地：四川成都"
)


class TestNormalize(unittest.TestCase):
    def test_extracts_codes_and_producer(self):
        n = normalize(DEMO_OCR, {"brand": "脉动"})
        self.assertEqual(n["sc_codes"], ["SC10651018300188"])
        self.assertIn("GB7101", n["std_nos"])
        self.assertEqual(n["label_producers"][0], "达能（中国）食品饮料有限公司")
        self.assertIn("四川省成都市邛崃市工业园区", n["label_addresses"])

    def test_ingredients_parsed(self):
        n = normalize(DEMO_OCR)
        self.assertEqual(n["ingredients"][0], "水")
        for want in ("白砂糖", "果葡糖浆", "维生素C"):
            self.assertIn(want, n["ingredients"])
        self.assertFalse(any("产品标准号" in i or "生产许可" in i for i in n["ingredients"]))

    def test_field_cut_stops_at_next_keyword(self):
        self.assertEqual(_clean_field("达能（中国）食品饮料有限公司 厂址：四川省成都市"),
                         "达能（中国）食品饮料有限公司")

    def test_missing_sc_not_fabricated(self):
        self.assertEqual(normalize("配料：水、糖")["sc_codes"], [])


class TestEvidenceRule(unittest.TestCase):
    def test_proven_without_source_is_demoted(self):
        self.assertEqual(ev("某地说这是广西糖", "proven", "guess")["confidence"], "probable")
        self.assertEqual(
            ev("有引用无链接", "proven", "c", url="", quote="引用")["confidence"], "probable")

    def test_proven_with_source_survives(self):
        e = ev("官网公示", "proven", "brand_official", url="https://x.test/", quote="全部生产工厂")
        self.assertEqual(e["confidence"], "proven")

    def test_label_is_first_hand(self):
        self.assertEqual(ev("包装标注厂址", "proven", "package_label", kind="label",
                            quote="四川省成都市")["confidence"], "proven")


class TestOfflineTrace(unittest.TestCase):
    """离线必须照常出结果，但只允许标注直读与品类先验，绝不产生联网结论。"""

    @classmethod
    def setUpClass(cls):
        cls.res = build_trace({"name": "脉动 维生素饮料", "brand": "脉动",
                               "category": "维生素饮料", "ocrText": DEMO_OCR}, live=False)

    def test_no_online_claims_when_offline(self):
        for e in self.res["provenance"]:
            self.assertNotIn(e["channel"], ("baidu_serp", "bing_rss", "brand_official", "openstd_gb"),
                             f"离线却产生了联网证据：{e}")

    def test_every_proven_has_quote(self):
        for e in self.res["provenance"]:
            if e["confidence"] == "proven":
                self.assertTrue(e["quote"], f"已证实却无原文引用：{e}")
                self.assertTrue(e["url"] or e["source_kind"] == "label", f"已证实却无出处：{e}")

    def test_raw_material_is_common_sense_not_evidence(self):
        raw = [n for n in self.res["nodes"] if n["stage"] == "raw"]
        self.assertTrue(raw)
        for it in raw[0]["items"]:
            self.assertEqual(it["confidence"], "unverified")
        # 未回源的常识不许混进证据链，否则证据计数就是虚的
        self.assertFalse(any(e["channel"] == "raw_prior_table" for e in self.res["provenance"]))
        self.assertTrue(all(not c["verified"] for c in self.res["common_sense"]))
        self.assertTrue(any(g["stage"] == "raw" for g in self.res["gaps"]))

    def test_unknown_stages_are_declared(self):
        stages = {n["stage"] for n in self.res["nodes"]}
        self.assertIn("shelf", stages)
        shelf = next(n for n in self.res["nodes"] if n["stage"] == "shelf")
        self.assertEqual(shelf["items"][0]["confidence"], "unknown")

    def test_compat_shape_for_frontend(self):
        for k in ("found", "place", "lines", "source"):
            self.assertIn(k, self.res["compat"])


class TestParsers(unittest.TestCase):
    def test_baidu_parser_reads_title_link_snippet(self):
        html = (
            '<div class="result c-container new-pmd">'
            '<h3 class="t"><a href="http://www.baidu.com/link?url=abc">达能（中国）食品饮料有限公司(饮料制造商) - 百度百科</a></h3>'
            '<div class="c-span-last">达能（中国）食品饮料有限公司成立于2012年，是脉动的生产企业。</div>'
            "</div>"
            '<div class="result c-container new-pmd">'
            '<h3 class="t"><a href="https://www.danone.com.cn/x.html">脉动 | 饮用水和饮料</a></h3>'
            '<span class="c-color-text">脉动全部生产工厂均已实现碳中和。</span>'
            "</div>"
        )
        hits = _parse_baidu(html)
        self.assertEqual(len(hits), 2)
        self.assertIn("达能", hits[0]["title"])
        self.assertTrue(hits[1]["url"].startswith("https://www.danone.com.cn"))
        self.assertIn("碳中和", hits[1]["snippet"])

    def test_empty_html_yields_nothing(self):
        self.assertEqual(_parse_baidu(""), [])
        self.assertEqual(_parse_baidu(None), [])


class TestEntityFilter(unittest.TestCase):
    """实测踩过的坑：灌装机厂家广告与百度文库数学题会被当成上游供应商。"""

    HITS = [
        {"title": "重磅发布！国内碳酸饮料灌装机厂家品牌展示", "url": "https://www.douyin.com/x",
         "snippet": "元气森林同款产线"},
        {"title": "元气森林（安徽）饮料有限公司 - 百度百科", "url": "https://baike.baidu.com/y",
         "snippet": "成立于2018年"},
        {"title": "(7分)一工厂生产某种商品,日销售量x与售价P之间的关系 - 百度文库",
         "url": "https://wenku.baidu.com/z", "snippet": "生产x件商品"},
        {"title": "某不相干饮料有限公司", "url": "https://ex.com/1", "snippet": "没有品牌词"},
    ]

    def test_keeps_only_real_entity(self):
        from app.backend.trace import _entity_hits
        kept, _ = _entity_hits(self.HITS, "元气森林")
        self.assertEqual([h["title"] for h in kept], ["元气森林（安徽）饮料有限公司 - 百度百科"])

    def test_short_brand_does_not_search(self):
        res = build_trace({"name": "某果味饮料", "brand": "某", "category": "",
                           "ocrText": "配料：水、糖"}, live=False)
        self.assertTrue(any(g["stage"] == "supplier" for g in res["gaps"]))


class TestStandardSelection(unittest.TestCase):
    """实测踩过的坑：标准号是子串检索，首条常常是另一个行业的标准。"""

    def _row(self, no, name, status="现行"):
        return {"std_no": no, "name": name, "kind": "推标", "status": status,
                "published": "2018-01-01", "effective": "2018-07-01", "quote": f"{no} {name}"}

    def test_rejects_substring_hit_from_other_industry(self):
        from app.backend.trace import select_standard
        rows = [self._row("GB/T13542.6-2006", "电气绝缘用薄膜 第6部分")]
        v = select_standard("GB/T1354", rows)
        self.assertEqual(v["matched"], [])
        self.assertIn("非该标准本身", v["reason"])

    def test_rejects_longer_part_number(self):
        from app.backend.trace import select_standard
        v = select_standard("GB/T10781.1", [self._row("GB/T10781.14-2025", "白酒质量要求 第14部分")])
        self.assertEqual(v["matched"], [])

    def test_exact_base_match_accepted(self):
        from app.backend.trace import select_standard
        v = select_standard("GB/T 10792", [self._row("GB/T10792-2008", "碳酸饮料(汽水)")])
        self.assertEqual(len(v["matched"]), 1)
        self.assertFalse(v["edition_certain"])
        self.assertIsNone(v["product_status"])

    def test_no_year_means_no_abolished_warning_on_product(self):
        """包装只写 GB 7101 时，不许把 2003 旧版的『废止』当成本品状态。"""
        from app.backend.trace import select_standard
        v = select_standard("GB7101", [self._row("GB7101-2003", "固体饮料卫生标准", status="废止")])
        self.assertTrue(v["matched"])
        self.assertFalse(v["edition_certain"])
        self.assertIsNone(v["product_status"])
        self.assertIn("未核验", v["reason"])

    def test_year_printed_on_pack_makes_status_actionable(self):
        from app.backend.trace import select_standard
        v = select_standard("GB7101-2003", [self._row("GB7101-2003", "固体饮料卫生标准", status="废止")])
        self.assertTrue(v["edition_certain"])
        self.assertEqual(v["product_status"], "废止")

    def test_prefers_current_over_abolished_edition(self):
        from app.backend.trace import select_standard
        rows = [self._row("GB/T10792-2008", "碳酸饮料", status="废止"),
                self._row("GB/T10792-2025", "碳酸饮料", status="现行")]
        v = select_standard("GB/T10792", rows)
        self.assertEqual(v["chosen"]["std_no"], "GB/T10792-2025")


class TestEntityIndustry(unittest.TestCase):
    def test_cross_industry_same_name_is_rejected(self):
        from app.backend.trace import _entity_hits
        hits = [{"title": "海天集团 - Haitian Group", "url": "https://haitian.com/",
                 "snippet": "海天集团是全球领先的注塑机制造商，主营塑机与装备制造"},
                {"title": "佛山市海天调味食品股份有限公司 - 百度百科", "url": "https://baike.baidu.com/x",
                 "snippet": "海天味业，主营酱油、蚝油等调味品"}]
        kept, rejected = _entity_hits(hits, "海天")
        self.assertEqual(len(kept), 1)
        self.assertIn("调味", kept[0]["title"])
        self.assertTrue(any("异行业" in r for r in rejected))

    def test_relation_flags_company_mismatch_with_label(self):
        from app.backend.trace import _entity_hits
        hits = [{"title": "元气森林（广东）饮料有限公司 - 百度百科", "url": "https://baike.baidu.com/y",
                 "snippet": "元气森林集团旗下饮料公司"}]
        kept, rejected = _entity_hits(hits, "元气森林", ["元气森林（安徽）饮料有限公司"])
        self.assertEqual(kept, [])
        self.assertTrue(any("不一致" in r and "广东" in r for r in rejected))

    def test_snippet_food_word_does_not_save_mismatched_company(self):
        from app.backend.trace import _entity_hits
        hits = [{"title": "海天集团 - Haitian Group", "url": "https://haitian.com/",
                 "snippet": "海天越南PET行业应用展：饮料包装、个人护理市场的PET成型方案"}]
        kept, rejected = _entity_hits(hits, "海天", ["佛山市海天调味食品股份有限公司"])
        self.assertEqual(kept, [])
        self.assertTrue(any("不一致" in r for r in rejected))

    def test_relation_ok_when_company_matches_label(self):
        from app.backend.trace import _entity_hits
        hits = [{"title": "元气森林（安徽）饮料有限公司 - 百度百科", "url": "https://baike.baidu.com/y",
                 "snippet": "饮料生产企业"}]
        kept, _ = _entity_hits(hits, "元气森林", ["元气森林（安徽）饮料有限公司"])
        self.assertIn("一致", kept[0]["relation"])
        self.assertNotIn("不一致", kept[0]["relation"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

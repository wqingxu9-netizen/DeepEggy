"""Local GTIN equivalence and exact-match precedence."""
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from app.backend.main import Handler, _equivalent_gtins


class BarcodeLookupTests(unittest.TestCase):
    def test_upca_and_ean13_are_equivalent_when_zero_padded(self):
        self.assertEqual(_equivalent_gtins('036000291452'),
                         ['036000291452', '0036000291452', '00036000291452'])
        self.assertEqual(_equivalent_gtins('0036000291452')[0], '0036000291452')
        self.assertIn('036000291452', _equivalent_gtins('0036000291452'))

    def test_invalid_or_demo_codes_are_not_rewritten(self):
        for code in ('6907992100013', '6902000100029', '0000000000000', 'abc'):
            self.assertEqual(_equivalent_gtins(code), [code])

    def test_lookup_prefers_exact_record_then_zero_padded_equivalent(self):
        handler = SimpleNamespace(path='/api/scan-barcode?code=0036000291452', PRODUCTS={},
                                  _json=lambda value: value)
        products = {'036000291452': {'name': 'short'}, '0036000291452': {'name': 'exact'}}
        with patch('app.backend.main._get_off_index', return_value=products):
            response = Handler.do_GET(handler)
        self.assertEqual(response['product']['name'], 'exact')
        del products['0036000291452']
        with patch('app.backend.main._get_off_index', return_value=products):
            response = Handler.do_GET(handler)
        self.assertEqual(response['matched_code'], '036000291452')


if __name__ == '__main__':
    unittest.main()

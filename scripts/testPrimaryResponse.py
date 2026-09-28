import unittest
from experimentPrimaryPages import normalize_response


class ContextResponseTest(unittest.TestCase):
    def test_only_explicit_context_task_may_omit_empty_tables(self):
        raw = {'nearTableText': ['示例银行']}
        self.assertEqual(normalize_response(raw, True), {**raw, 'tables': []})
        self.assertNotIn('tables', raw)
        with self.assertRaises(ValueError): normalize_response(raw)

    def test_unexpected_and_transaction_payloads_are_rejected(self):
        for raw in [{'nearTableText': [], 'rows': []}, {'nearTableText': [], 'tables': [{'rows': []}]},
                    {'nearTableText': '银行'}, {'nearTableText': [], 'tables': None}]:
            with self.assertRaises(ValueError): normalize_response(raw, True)


if __name__ == '__main__':
    unittest.main()

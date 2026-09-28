import unittest
from evaluateStatementUncertainty import align_rows


class EvaluationAlignmentTests(unittest.TestCase):
    def test_repeated_transfers_are_not_missing_when_full_times_match(self):
        gold = [['001234567890', '甲', '某银行', f'2026-07-10 12:00:{second:02}',
                 '2026-07-10', 'OUT', '188.00', '100.00', '第三方支付', '微信', '1000050201', '']
                for second in [11, 27]]
        actual = [list(row) for row in reversed(gold)]
        for row in actual:
            row[2] = '某银行股份有限公司'
        pairs, methods = align_rows(gold, actual)
        self.assertEqual(pairs, {0: 1, 1: 0})
        self.assertEqual(methods['account_timestamp_direction_amount_balance_counterparty'], 2)

    def test_identical_occurrences_preserve_multiplicity(self):
        row = ['001234567890', '甲', '', '', '2026-07-10', 'OUT', '188.00', '100.00', '', '', '', '']
        pairs, methods = align_rows([row, row], [row, row])
        self.assertEqual(pairs, {0: 0, 1: 1})
        self.assertEqual(methods['identical_12_column_occurrence'], 2)
        self.assertEqual(len(align_rows([row, row], [row])[0]), 1)
        self.assertEqual(len(align_rows([row], [row, row])[0]), 1)

    def test_duplicate_amounts_cannot_hide_changed_fields(self):
        row = ['001234567890', '甲', '', '', '2026-07-10', 'OUT', '188.00', '100.00', '', '商户甲', '', '']
        wrong = list(row)
        wrong[9] = '商户乙'
        pairs, _ = align_rows([row, row], [row, wrong])
        self.assertEqual(pairs, {0: 0})


if __name__ == '__main__':
    unittest.main()

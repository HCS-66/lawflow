"""A recovered early page must not redirect later field references."""
import json
from pathlib import Path
import tempfile
import unittest
from stabilizeRecoveredMapping import stabilize


class MappingStabilityTest(unittest.TestCase):
    def test_changed_early_page_keeps_later_mapping_and_rebases_every_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, shift in [('old', 0), ('new', 10)]:
                path = root / name; path.mkdir()
                registry = {'pages': [1, 2], 'cells': {
                    '1': {'id': 1, 'page': 1, 'row': None, 'column': None, 'text': 'old' if not shift else 'new'},
                    str(2 + shift): {'id': 2 + shift, 'page': 2, 'row': None, 'column': None, 'text': '示例银行'},
                    str(3 + shift): {'id': 3 + shift, 'page': 2, 'row': 1 + shift, 'column': 1, 'text': '10.00'}},
                    'rows': {str(1 + shift): {'id': 1 + shift, 'page': 2, 'table': 1, 'row': 1, 'cells': [3 + shift]}}}
                mapping = {'tables': [{'page': 2, 'table': 1, 'kind': 'transactions', 'accountKind': 'deposit',
                    'fields': {'bankName': {'fixed': 2 + shift}, 'amount': {'row': 0, 'col': 1 if not shift else 9}},
                    'groups': [[1 + shift]], 'ignored': [], 'directionCodes': {},
                    'overrides': [{'firstRow': 1 + shift, 'fields': {'bankName': {'fixed': 2 + shift}}}]}], 'typeRules': []}
                (path / 'registry.json').write_text(json.dumps(registry))
                (path / 'layout.json').write_text(json.dumps(mapping))
            result = stabilize(root / 'old', root / 'new', root / 'stable')
            table = json.loads((root / 'stable/layout.json').read_text())['tables'][0]
            self.assertEqual(result['reusedTables'], [[2, 1]])
            self.assertEqual(table['groups'], [[11]])
            self.assertEqual(table['fields']['amount']['col'], 1)
            self.assertEqual(table['fields']['bankName']['fixed'], 12)
            self.assertEqual(table['overrides'][0]['firstRow'], 11)
            self.assertEqual(table['overrides'][0]['fields']['bankName']['fixed'], 12)


if __name__ == '__main__': unittest.main()

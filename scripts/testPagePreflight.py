"""Focused preprocessing checks with synthetic pages and no model calls."""
import json
from pathlib import Path
import tempfile
import unittest
from qualityPagePreflight import decide, blank_wrapper, is_verified_blank, validate_classification
from qualityPreflightPlan import load_plan
from experimentSourceAssembly import build_sources
from mergePrimaryContext import merge_context


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.metrics = {'width': 100, 'height': 200, 'darkFraction160': 0, 'darkFraction210': 0}
        self.blank = {'pageKind': 'blank', 'clockwiseRotation': None, 'reason': 'No content'}

    def test_model_alone_cannot_remove_a_page(self):
        self.assertTrue(decide(self.blank, self.metrics, False)['blankConfirmed'])
        self.assertFalse(decide(self.blank, self.metrics, True)['blankConfirmed'])
        self.assertFalse(decide(self.blank, {**self.metrics, 'darkFraction210': .001}, False)['blankConfirmed'])

    def test_uncertain_and_nontransaction_documents_are_retained(self):
        for kind in ('content', 'uncertain'):
            self.assertFalse(decide({**self.blank, 'pageKind': kind}, self.metrics, False)['blankConfirmed'])

    def test_rotation_follows_text_not_page_aspect(self):
        for rotation in (0, 90, 180, 270):
            value = {**self.blank, 'pageKind': 'content', 'clockwiseRotation': rotation}
            self.assertEqual(decide(value, self.metrics, False)['clockwiseRotation'], rotation)
        for invalid in (True, 45, '90'):
            with self.assertRaises(ValueError):
                validate_classification({**self.blank, 'pageKind': 'content', 'clockwiseRotation': invalid})

    def test_skip_has_explicit_provenance_and_no_fabricated_model_success(self):
        page = {'page': 2, 'classification': self.blank, 'decision': decide(self.blank, self.metrics, False),
                'imageSHA256': 'a' * 64, 'responseSHA256': 'b' * 64}
        wrapper = blank_wrapper(page)
        self.assertEqual(wrapper['finishReason'], 'SKIPPED_BLANK')
        self.assertTrue(is_verified_blank(wrapper))
        wrapper['preflight']['blankConfirmed'] = False
        self.assertFalse(is_verified_blank(wrapper))
        with self.assertRaises(ValueError):
            blank_wrapper({**page, 'decision': {**page['decision'], 'blankConfirmed': False}})

    def test_128_pages_keep_numeric_order_in_full_text_mapping(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for page in range(1, 129):
                value = {'page': page, 'finishReason': 'stop', 'result': {'nearTableText': [f'page {page}'], 'tables': []}}
                (root / f'page-{page:02}.json').write_text(json.dumps(value))
            pages, registry = build_sources(root)
            self.assertEqual(registry['pages'], list(range(1, 129)))
            self.assertEqual(pages[99]['page'], 100)

    def test_plan_cannot_skip_without_evidence_or_use_wrong_rotation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value = {'pageKind': 'content', 'clockwiseRotation': 90, 'reason': 'Text sideways'}
            page = {'page': 1, 'classification': value, 'metrics': self.metrics, 'decision': decide(value, self.metrics, False)}
            plan = {'complete': True, 'policyVersion': 'FULL_PAGE_PREFLIGHT_V1', 'sourceSHA256': 'source', 'pages': [page]}
            target = root / 'plan.json'; target.write_text(json.dumps(plan))
            rendered = {'sourceSHA256': 'source', 'totalPages': 1, 'extraClockwiseRotation': {}}
            (root / 'render-manifest.json').write_text(json.dumps(rendered))
            with self.assertRaises(ValueError): load_plan(target, root)
            rendered['extraClockwiseRotation'] = {'1': 90}
            (root / 'render-manifest.json').write_text(json.dumps(rendered))
            self.assertEqual(load_plan(target, root)[1]['page'], 1)
            page['decision']['blankConfirmed'] = True
            target.write_text(json.dumps(plan))
            with self.assertRaises(ValueError): load_plan(target, root)

    def test_page_context_preserves_transaction_cells_and_rejects_extra_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            primary, context = root / 'primary', root / 'context'
            primary.mkdir(); context.mkdir()
            raw = {'page': 1, 'finishReason': 'STOP', 'result': {
                'nearTableText': ['本方账户'], 'tables': [{'rows': [['2026-01-01', '10.00']]}]}}
            extra = {'page': 1, 'finishReason': 'STOP', 'result': {'nearTableText': ['示例银行'], 'tables': []}}
            (primary / 'page-01.json').write_text(json.dumps(raw))
            (context / 'page-01.json').write_text(json.dumps(extra))
            merge_context(primary, context, root / 'merged')
            output = json.loads((root / 'merged/page-01.json').read_text())
            self.assertEqual(output['result']['tables'], raw['result']['tables'])
            self.assertEqual(output['result']['nearTableText'], ['本方账户', '示例银行'])
            self.assertEqual(json.loads((primary / 'page-01.json').read_text()), raw)
            extra['result']['tables'] = [{'rows': [['invented']]}]
            (context / 'page-01.json').write_text(json.dumps(extra))
            with self.assertRaises(ValueError): merge_context(primary, context, root / 'invalid')


if __name__ == '__main__': unittest.main()

"""Validate the preflight evidence and its application to final page renders."""
import json
from qualityPagePreflight import POLICY_VERSION, decide


def load_plan(path, images):
    plan = json.loads(path.read_text())
    rendered = json.loads((images / 'render-manifest.json').read_text())
    if (not plan.get('complete') or plan.get('policyVersion') != POLICY_VERSION
        or plan.get('sourceSHA256') != rendered['sourceSHA256']
        or [p['page'] for p in plan['pages']] != list(range(1, rendered['totalPages'] + 1))):
        raise ValueError('Preflight plan does not cover this source document')
    for page in plan['pages']:
        expected = decide(page['classification'], page['metrics'], page['decision']['hasPdfText'])
        if page['decision'] != expected:
            raise ValueError('Preflight decision disagrees with its evidence')
        if rendered['extraClockwiseRotation'].get(str(page['page']), 0) != expected['clockwiseRotation']:
            raise ValueError('Rendered page direction disagrees with the preflight decision')
    return {p['page']: p for p in plan['pages']}

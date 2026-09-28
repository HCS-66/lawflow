"""Attach independently transcribed page headings without replacing transaction cells."""
import hashlib
import json
from pathlib import Path
import re

from experimentPrimaryPages import validate
from qualityPagePreflight import is_verified_blank


def merge_context(primary, context, output):
    pages = sorted((p for p in primary.glob('page-*.json') if re.fullmatch(r'page-\d+\.json', p.name)),
                   key=lambda p: int(p.stem.split('-')[1]))
    inputs = {}
    merged = []
    for source in pages:
        original = json.loads(source.read_text())
        addition_path = context / source.name
        addition = json.loads(addition_path.read_text())
        for path, wrapper in [(source, original), (addition_path, addition)]:
            if wrapper.get('finishReason') not in ('STOP', 'stop') and not is_verified_blank(wrapper):
                raise ValueError('Incomplete context or primary response')
            validate(wrapper['result'])
            inputs[str(path.resolve())] = hashlib.sha256(path.read_bytes()).hexdigest()
        if original['page'] != addition['page'] or addition['result']['tables']:
            raise ValueError('Context must contain headings for the same page, without transaction tables')
        if is_verified_blank(original) and addition['result']['nearTableText']:
            raise ValueError('Blank decision conflicts with new context; retain the conflict for a new preflight run')
        text = original['result']['nearTableText']
        for line in addition['result']['nearTableText']:
            if line not in text:
                text.append(line)
        original['pageContextEvidence'] = {'path': str(addition_path.resolve()),
            'sha256': inputs[str(addition_path.resolve())], 'transactionCellsChanged': False}
        merged.append((source.name, original))
    manifest = {'kind': 'APPEND_PRINTED_PAGE_CONTEXT', 'inputs': inputs, 'standardAnswersRead': False,
                'transactionCellsChanged': False}
    if output.exists():
        if json.loads((output / 'context-manifest.json').read_text()) != manifest:
            raise ValueError('Existing context output has different inputs')
        return
    output.mkdir(parents=True)
    for name, wrapper in merged:
        (output / name).write_text(json.dumps(wrapper, ensure_ascii=False, indent=2))
    (output / 'context-manifest.json').write_text(json.dumps(manifest, indent=2))

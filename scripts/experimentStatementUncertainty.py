"""Isolated two-stage uncertainty experiment; no gold data in either API request."""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
import getpass
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

from experimentGeminiStage2Verbatim import request_all
from experimentQwenPageImages import request_page
from experimentQwenStage2Verbatim import COLUMNS
from experimentThreePassStatement import read_key

STAGE1_PROMPT = Path('scripts/prompts/qwenPagewiseUncertaintyV1.txt')
STAGE2_PROMPT = Path('scripts/prompts/geminiVerbatimUncertaintyV1.txt')


def request_plain(image, key, prompt):
    payload = {
        'model': 'qwen3.8-flash',
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': prompt},
            {'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,' + base64.b64encode(image.read_bytes()).decode('ascii')}}]}],
        'reasoning_effort': 'low', 'vl_high_resolution_images': True,
        'temperature': 0, 'max_tokens': 16000}
    req = urllib.request.Request('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
                                 data=json.dumps(payload, ensure_ascii=False).encode(),
                                 headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=300) as response:
        return json.load(response)


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def parse_response(text):
    stripped = text.strip()
    fenced = stripped.startswith('```json\n') and stripped.endswith('\n```')
    if fenced:
        stripped = stripped[len('```json\n'):-len('\n```')]
    return json.loads(stripped), fenced


def validate_page(result):
    if not isinstance(result.get('nearTableText'), list) or not all(
            isinstance(t, str) for t in result['nearTableText']):
        raise ValueError('Invalid nearTableText')
    if not isinstance(result.get('tables'), list):
        raise ValueError('Invalid tables')
    for table in result['tables']:
        rows = table['rows']
        if not isinstance(rows, list) or not all(isinstance(r, list) and all(isinstance(c, str) for c in r) for r in rows):
            raise ValueError('Invalid cells')
        confidence = table['rowConfidence']
        if not isinstance(confidence, list) or any(c not in ('high', 'medium', 'low') for c in confidence):
            raise ValueError('Invalid rowConfidence')
        for issue in table['cellIssues']:
            r, c = issue['row'], issue['column']
            if not isinstance(r, int) or not isinstance(c, int):
                raise ValueError('Invalid cell issue index type')
            if issue['status'] not in ('uncertain', 'unreadable', 'truncated'):
                raise ValueError('Invalid cell issue status')
    for issue in result['nearTextIssues']:
        if not 1 <= issue['line'] <= len(result['nearTableText']):
            raise ValueError('Invalid header issue location')
    if result['pageReview']['coverage'] not in ('complete', 'uncertain'):
        raise ValueError('Invalid page coverage')
    if result['pageReview']['tablePresence'] not in ('present', 'none', 'uncertain'):
        raise ValueError('Invalid table presence')


def stage1(args):
    output = args.output / 'stage1'
    output.mkdir(parents=True, exist_ok=True)
    key = getpass.getpass('Qwen API key (hidden): ')
    if not key:
        raise ValueError('Missing Qwen key')
    key = key.replace('\\_', '_')
    prompt = STAGE1_PROMPT.read_text()

    def run_page(page):
        path = output / f'page-{page:02d}.json'
        if path.exists():
            saved = json.loads(path.read_text())
            if saved.get('finishReason') != 'stop':
                raise ValueError(f'Page {page}: previous response incomplete; retained for diagnosis')
            validate_page(saved['result'])
            return {'page': page, 'cached': True}
        image = args.images / f'upright-{page:02d}.jpg'
        started = time.monotonic()
        try:
            response = (request_plain(image, key, prompt) if args.plain_json else
                        request_page(image, key, 'qwen3.8-flash',
                                     'https://dashscope.aliyuncs.com/compatible-mode/v1', prompt))
        except urllib.error.HTTPError as error:
            # Keep diagnostic code/message, never headers, request body or credentials.
            try:
                body = json.loads(error.read(4096))
                detail = body.get('error', body)
                if not isinstance(detail, dict):
                    detail = {}
                message = str(detail.get('message', ''))[:700].replace(key, '[REDACTED]')
                code = str(detail.get('code', ''))
            except (ValueError, TypeError):
                message, code = 'No JSON error detail', ''
            raise RuntimeError(f'Page {page}: HTTP {error.code} {code}: {message}') from None
        choice = response.get('choices', [{}])[0]
        raw = choice.get('message', {}).get('content', '')
        wrapper = {'page': page, 'model': response.get('model'),
                   'finishReason': choice.get('finish_reason'), 'usage': response.get('usage'),
                   'responseFormat': 'prompt_only_json' if args.plain_json else 'json_object',
                   'seconds': round(time.monotonic() - started, 2)}
        try:
            wrapper['result'], fenced = parse_response(raw)
            if fenced:
                wrapper['rawContent'] = raw
                wrapper['transportNormalization'] = 'Removed enclosing Markdown JSON fence only'
        except (ValueError, TypeError):
            wrapper['unparsedContent'] = raw
            save(path, wrapper)
            raise ValueError(f'Page {page}: invalid JSON') from None
        save(path, wrapper)
        if wrapper['finishReason'] != 'stop':
            raise ValueError(f'Page {page}: incomplete output')
        validate_page(wrapper['result'])
        tables = wrapper['result']['tables']
        stats = {'page': page, 'rows': sum(len(t['rows']) for t in tables),
                 'uncertainRows': sum(c != 'high' for t in tables for c in t['rowConfidence']),
                 'cellIssues': sum(len(t['cellIssues']) for t in tables), 'seconds': wrapper['seconds']}
        print(json.dumps(stats), flush=True)
        return stats

    # Check one page before dispatching the rest, so auth/schema errors stop early.
    selected = [int(p) for p in args.selected_pages.split(',')] if args.selected_pages else list(range(1, 28))
    results = [run_page(selected[0])]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(run_page, p): p for p in selected[1:]}
        for job in as_completed(jobs):
            try:
                results.append(job.result())
            except Exception as error:
                print(f'Page {jobs[job]} failed: {type(error).__name__}: {error}', flush=True)
                results.append({'page': jobs[job], 'error': str(error)})
    manifest = {'model': 'qwen3.8-flash', 'promptSHA256': hashlib.sha256(STAGE1_PROMPT.read_bytes()).hexdigest(),
                'temperature': 0, 'reasoning_effort': 'low', 'max_tokens': 16000,
                'workers': args.workers, 'retries': 0,
                'selectedPages': selected, 'responseFormat': 'prompt_only_json' if args.plain_json else 'json_object',
                'images': {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
                           for p in sorted(args.images.glob('upright-*.jpg'))},
                'pages': sorted(results, key=lambda r: r['page'])}
    history = args.output / 'stage1-attempts'
    history.mkdir(exist_ok=True)
    save(history / f'attempt-{len(list(history.glob("attempt-*.json"))) + 1}.json', manifest)
    save(args.output / 'stage1-manifest.json', manifest)
    if any('error' in r for r in results):
        raise SystemExit('Stage 1 has failures; stage 2 not started')


def prepare_input(root):
    pages, registry, row_registry = [], {}, {}
    next_cell, next_row, next_header = 1, 1, 1
    for p in range(1, 28):
        wrapped = json.loads((root / 'stage1' / f'page-{p:02d}.json').read_text())
        if wrapped['finishReason'] != 'stop':
            raise ValueError(f'Incomplete page {p}')
        result = wrapped['result']
        validate_page(result)
        page = {'page': p, 'nearTableText': [], 'tables': [], 'pageReview': result['pageReview'], 'schemaIssues': []}
        for n, text in enumerate(result['nearTableText'], 1):
            ref = f'h{next_header}'
            next_header += 1
            issues = [i for i in result['nearTextIssues'] if i['line'] == n]
            page['nearTableText'].append({'id': ref, 'text': text, 'issues': issues})
            registry[ref] = {'text': text, 'page': p, 'location': f'p{p}h{n}', 'issues': issues}
        for t, table in enumerate(result['tables'], 1):
            new_table = {'id': f'p{p}t{t}', 'rows': []}
            confidence_valid = len(table['rowConfidence']) == len(table['rows'])
            if not confidence_valid:
                new_table['schemaIssue'] = '行置信度数量与原文行数不一致，不能可靠对应；所有行置信度标记为 unknown，保留原始输出供检查。'
                page['schemaIssues'].append(f'表格{t}行置信度数量与原文行数不一致。')
            unlocated = [i for i in table['cellIssues'] if not (
                1 <= i['row'] <= len(table['rows']) and 1 <= i['column'] <= len(table['rows'][i['row'] - 1]))]
            if unlocated:
                new_table['unlocatedIssues'] = unlocated
                page['schemaIssues'].append(f'表格{t}有{len(unlocated)}条疑点引用了不存在的原格，无法定位。')
            for r, cells in enumerate(table['rows'], 1):
                ref = f'r{next_row}'
                next_row += 1
                cell_refs = [f'c{n}' for n in range(next_cell, next_cell + len(cells))]
                next_cell += len(cells)
                issues = [i for i in table['cellIssues'] if i['row'] == r and 1 <= i['column'] <= len(cells)]
                new_row = {'id': ref, 'cells': cells, 'cellRefs': cell_refs,
                           'confidence': table['rowConfidence'][r - 1] if confidence_valid else 'unknown',
                           'issues': issues}
                new_table['rows'].append(new_row)
                row_registry[ref] = {**new_row, 'page': p, 'location': f'p{p}t{t}r{r}'}
                for c, text in enumerate(cells, 1):
                    registry[cell_refs[c - 1]] = {'text': text, 'page': p, 'row': ref,
                                             'location': f'p{p}t{t}r{r}c{c}',
                                             'issues': [i for i in issues if i['column'] == c]}
            page['tables'].append(new_table)
        pages.append(page)
    return pages, registry, row_registry


def stage2(args):
    pages, cells, rows = prepare_input(args.output)
    save(args.output / 'stage2-input.json', pages)
    save(args.output / 'source-registry.json', {'cells': cells, 'rows': rows})
    folder = args.output / ('stage2-compact-v2' if args.compact else 'stage2')
    folder.mkdir(exist_ok=False)
    prompt_file = Path('scripts/prompts/geminiVerbatimUncertaintyCompactV2.txt') if args.compact else STAGE2_PROMPT
    prompt = prompt_file.read_text()
    if args.compact:
        pages = json.loads(json.dumps(pages))
        for page in pages:
            for header in page['nearTableText']:
                header['id'] = -int(header['id'][1:])
            for table in page['tables']:
                for row in table['rows']:
                    row['id'] = int(row['id'][1:])
                    row['cellRefs'] = [int(ref[1:]) for ref in row['cellRefs']]
        save(folder / 'compact-input.json', pages)
    save(folder / 'manifest.json', {
        'model': 'gemini-3.8-flash', 'temperature': 0, 'thinkingLevel': 'low', 'maxOutputTokens': 65536,
        'promptSHA256': hashlib.sha256(prompt_file.read_bytes()).hexdigest(),
        'inputSHA256': hashlib.sha256((folder / 'compact-input.json' if args.compact else args.output / 'stage2-input.json').read_bytes()).hexdigest(),
        'scope': 'One request, one list of 27 pages, no images/PDF/gold; sparse issues plus field references.'})
    print('Stage 2: sending one list of 27 pages with uncertainty annotations', flush=True)
    response = request_all(read_key(), 'gemini-3.8-flash', prompt, pages, folder)
    save(folder / 'all-response.json', response)
    if response['finishReason'] != 'STOP':
        raise ValueError('Stage 2 output incomplete; retained but not exported as final CSV')
    data = json.loads(response['rawContent'])
    if args.compact:
        normalized = []
        def cell_ref(ref):
            if not isinstance(ref, int):
                raise ValueError('Compact source reference must be an integer')
            return f'c{ref}' if ref > 0 else f'h{-ref}' if ref < 0 else ''
        for raw in data['rows']:
            if len(raw['k']) != 5:
                raise ValueError('Compact key-field references must have five elements')
            refs = [[] for _ in range(12)]
            for f, ref in zip((0, 5, 6, 7, 10), raw['k']):
                if ref:
                    refs[f].append(cell_ref(ref))
            issues = []
            for f, kind, reason, source_ids in raw['u']:
                source_refs = [cell_ref(ref) for ref in source_ids if ref]
                issues.append({'field': f, 'kind': kind, 'reason': reason, 'refs': source_refs})
                if 0 <= f < 12:
                    refs[f].extend(ref for ref in source_refs if ref not in refs[f])
            normalized.append({'values': raw['v'], 'sourceRows': [f'r{ref}' for ref in raw['s']],
                               'refs': refs, 'confidence': raw['c'], 'issues': issues,
                               'referenceScope': 'critical_fields_and_reported_issues'})
        save(folder / 'compact-structured.json', data)
        data = {'rows': normalized}
    for row in data['rows']:
        if len(row['values']) != 12 or not all(isinstance(v, str) for v in row['values']):
            raise ValueError('Invalid 12-column values')
        if len(row['refs']) != 12 or not all(isinstance(refs, list) and all(isinstance(ref, str) for ref in refs) for refs in row['refs']):
            raise ValueError('Invalid field references')
        if row['confidence'] not in ('high', 'medium', 'low'):
            raise ValueError('Invalid confidence')
        if not isinstance(row['sourceRows'], list) or not all(isinstance(ref, str) for ref in row['sourceRows']):
            raise ValueError('Invalid row sources')
        if not isinstance(row['issues'], list):
            raise ValueError('Invalid issues')
        for issue in row['issues']:
            if not isinstance(issue.get('field'), int) or not -1 <= issue['field'] <= 11:
                raise ValueError('Invalid issue field')
    save(folder / 'structured.json', data)
    with (folder / 'standard.csv').open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(COLUMNS)
        writer.writerows(row['values'] for row in data['rows'])
    print(f'Stage 2: {len(data["rows"])} transactions, {response["seconds"]} seconds', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['stage1', 'stage2'])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--images', type=Path, default=Path('tmp/qwen-pagewise-upright/images'))
    parser.add_argument('--workers', type=int, default=3)
    parser.add_argument('--plain-json', action='store_true', help='Prompt-only JSON for pages rejected by provider JSON mode')
    parser.add_argument('--selected-pages', help='Only retry these page numbers; retain all other saved responses')
    parser.add_argument('--compact', action='store_true', help='Compact stage-2 output with numeric sources and five critical-field references')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    {'stage1': stage1, 'stage2': stage2}[args.stage](args)

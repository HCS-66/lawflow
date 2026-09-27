"""Repeatable full-page primary extraction; credentials arrive on stdin only."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import sys
import time
import urllib.error

from experimentQwenPageImages import request_page
from experimentIndependentKeys import save
from strictModelJson import loads as strict_loads


def validate(result):
    if not isinstance(result, dict) or not isinstance(result.get('tables'), list):
        raise ValueError('Missing tables')
    if not isinstance(result.get('nearTableText'), list) or not all(isinstance(x, str) for x in result['nearTableText']):
        raise ValueError('Invalid near-table text')
    if set(result) != {'nearTableText', 'tables'}:
        raise ValueError('Unexpected output fields; transaction text may be outside the row array')
    for table in result['tables']:
        if not isinstance(table, dict) or not isinstance(table.get('rows'), list):
            raise ValueError('Invalid table')
        if set(table) != {'rows'}:
            raise ValueError('Unexpected table fields; row coverage cannot be trusted')
        if not all(isinstance(row, list) and all(isinstance(cell, str) for cell in row) for row in table['rows']):
            raise ValueError('Invalid row/cell')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--images', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pages', type=int, required=True)
    parser.add_argument('--selected-pages', help='Comma-separated pages for a bounded recovery run')
    parser.add_argument('--workers', type=int, default=3)
    parser.add_argument('--prompt', type=Path, default=Path('scripts/prompts/qwenPagewiseVerbatimV3.txt'))
    parser.add_argument('--model', default='qwen3.8-flash')
    parser.add_argument('--base-url', default='https://dashscope.aliyuncs.com/compatible-mode/v1')
    args = parser.parse_args()
    key = sys.stdin.readline().strip().replace('\\_', '_')
    if not key:
        raise ValueError('Missing credential on stdin')
    prompt = args.prompt.read_bytes()
    selected = [int(p) for p in args.selected_pages.split(',')] if args.selected_pages else list(range(1, args.pages + 1))
    if not selected or len(set(selected)) != len(selected) or any(p < 1 or p > args.pages for p in selected):
        raise ValueError('Invalid selected pages')
    digest = lambda data: hashlib.sha256(data).hexdigest()
    manifest = {'model': args.model, 'promptSHA256': digest(prompt), 'pages': selected,
                'images': {str(p): digest((args.images / f'upright-{p:02}.jpg').read_bytes()) for p in selected},
                'temperature': 0, 'reasoningEffort': 'low', 'maxTokens': 16000, 'standardAnswersIncluded': False}
    args.output.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output / 'input-manifest.json'
    if manifest_path.exists() and json.loads(manifest_path.read_text()) != manifest:
        raise ValueError('Input/configuration mismatch; use a new directory')
    save(manifest_path, manifest)

    def run(page):
        path = args.output / f'page-{page:02}.json'
        if path.exists():
            existing = json.loads(path.read_text())
            if existing.get('finishReason') == 'stop':
                try:
                    validate(existing['result'])
                    return {'page': page, 'cached': True}
                except ValueError:
                    path.rename(args.output / f'page-{page:02}-invalid-cache-{int(time.time() * 1000)}.json')
        for attempt in range(1, 4):
            started = time.monotonic()
            attempt_path = args.output / f'page-{page:02}-attempt-{int(time.time() * 1000)}.json'
            try:
                response = request_page(args.images / f'upright-{page:02}.jpg', key, args.model, args.base_url, prompt.decode())
                save(attempt_path, response)
                choice = response['choices'][0]
                if choice.get('finish_reason') != 'stop':
                    raise ValueError('Response did not finish normally')
                result = strict_loads(choice['message']['content'])
                validate(result)
                seconds = round(time.monotonic() - started, 2)
                save(path, {'page': page, 'model': response.get('model'), 'finishReason': 'stop',
                            'usage': response.get('usage'), 'seconds': seconds, 'result': result})
                stats = {'page': page, 'rows': sum(len(t['rows']) for t in result['tables']), 'seconds': seconds}
                print(json.dumps(stats), flush=True)
                return stats
            except urllib.error.HTTPError as error:
                reason = f'HTTP {error.code}'
                body = error.read(1500).decode('utf-8', 'replace').replace(key, '[REDACTED]')
                save(attempt_path.with_suffix('.error.json'), {'error': reason, 'detail': body})
                # This provider has returned intermittent 400s for identical,
                # previously successful image requests. One retry remains bounded.
                retryable = error.code in (408, 429, 500, 502, 503, 504) or (error.code == 400 and attempt == 1)
                if not retryable or attempt == 3:
                    raise RuntimeError(reason) from None
                time.sleep(attempt * 2)
            except Exception as error:
                reason = str(error).replace(key, '[REDACTED]')[:200]
                save(attempt_path.with_suffix('.error.json'), {'error': reason})
                if attempt == 3:
                    raise RuntimeError(reason) from None
        raise RuntimeError('No completed response')

    results = [run(selected[0])]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(run, page): page for page in selected[1:]}
        for future in as_completed(futures):
            try:
                results.append(future.result())
            except Exception as error:
                failure = {'page': futures[future], 'error': str(error).replace(key, '[REDACTED]')[:200]}
                results.append(failure)
                print(json.dumps(failure), flush=True)
    complete = all('error' not in item for item in results)
    save(args.output / 'run-summary.json', {'pages': sorted(results, key=lambda item: item['page']), 'complete': complete})
    if not complete:
        raise SystemExit(1)


if __name__ == '__main__':
    main()

"""Independent whole-page reading. No standard answers or primary predictions are loaded."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

from experimentThreePassStatement import read_key
from strictModelJson import loads as strict_loads


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, data):
    temporary = path.with_suffix(path.suffix + '.writing')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    temporary.replace(path)


def validate(result):
    if result.get('pageType') not in ('transactions', 'account_info', 'document', 'blank', 'uncertain'):
        raise ValueError('Invalid page type')
    if result.get('coverage') not in ('complete', 'uncertain'):
        raise ValueError('Invalid coverage')
    if not isinstance(result.get('pageIssues'), list) or not all(isinstance(x, str) for x in result['pageIssues']):
        raise ValueError('Invalid page issues')
    rows = result.get('rows')
    if not isinstance(rows, list):
        raise ValueError('Missing rows')
    for i, row in enumerate(rows, 1):
        values = row.get('values')
        if row.get('row') != i or not isinstance(values, list) or len(values) != 8 or not all(isinstance(v, str) for v in values):
            raise ValueError('Invalid transaction row')
        if not isinstance(row.get('rawDirection'), str) or not isinstance(row.get('issues'), list):
            raise ValueError('Missing raw direction/issues')
        for issue in row['issues']:
            if issue.get('field') not in ('accountNumber', 'transactionDate', 'transactionTime', 'direction', 'amount', 'balance', 'counterpartyName', 'counterpartyAccount'):
                raise ValueError('Invalid issue field')
            if issue.get('kind') not in ('uncertain', 'truncated', 'unreadable') or not isinstance(issue.get('reason'), str):
                raise ValueError('Invalid issue')
    if rows and result['pageType'] != 'transactions':
        raise ValueError('Transactions disagree with page type')
    if 'bankName' in result and not isinstance(result['bankName'], str):
        raise ValueError('Invalid bank metadata')
    if 'ownerNames' in result and (not isinstance(result['ownerNames'], list) or not all(isinstance(v, str) for v in result['ownerNames'])):
        raise ValueError('Invalid owner metadata')
    if 'ownerIdentifiers' in result:
        if not isinstance(result['ownerIdentifiers'], list) or not all(isinstance(v, dict) and v.get('role') in ('account', 'card')
          and isinstance(v.get('value'), str) for v in result['ownerIdentifiers']):
            raise ValueError('Invalid owner identifiers')


def request(key, model, prompt, image, partial):
    payload = {'contents': [{'role': 'user', 'parts': [
        {'text': prompt}, {'inlineData': {'mimeType': 'image/jpeg', 'data': base64.b64encode(image).decode()}}
    ]}], 'generationConfig': {'responseMimeType': 'application/json', 'temperature': 0,
                            'thinkingConfig': {'thinkingLevel': 'low'}, 'maxOutputTokens': 24000}}
    req = urllib.request.Request(
        f'https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse',
        data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={'Content-Type': 'application/json', 'x-goog-api-key': key}, method='POST')
    chunks, usage, finish = [], None, None
    started = time.monotonic()
    with urllib.request.urlopen(req, timeout=300) as response, partial.open('w') as stream:
        for line in response:
            if not line.startswith(b'data: '):
                continue
            event = json.loads(line[6:])
            if 'error' in event:
                raise RuntimeError('Provider stream error')
            usage = event.get('usageMetadata', usage)
            for candidate in event.get('candidates', []):
                finish = candidate.get('finishReason', finish)
                content = ''.join(p.get('text', '') for p in candidate.get('content', {}).get('parts', []) if not p.get('thought'))
                chunks.append(content)
                stream.write(content)
                stream.flush()
    return {'model': model, 'finishReason': finish, 'usage': usage,
            'seconds': round(time.monotonic() - started, 2), 'rawContent': ''.join(chunks)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--images', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pages', default='1-27')
    parser.add_argument('--workers', type=int, default=3)
    parser.add_argument('--model', default='gemini-3.8-flash')
    parser.add_argument('--prompt', type=Path, default=Path('scripts/prompts/geminiIndependentKeysV1.txt'))
    args = parser.parse_args()
    selected = []
    for group in args.pages.split(','):
        if '-' in group:
            first, last = map(int, group.split('-'))
            selected.extend(range(first, last + 1))
        else:
            selected.append(int(group))
    if not selected or len(set(selected)) != len(selected):
        raise ValueError('Select unique pages')
    args.output.mkdir(parents=True, exist_ok=True)
    prompt_bytes = args.prompt.read_bytes()
    manifest = {'model': args.model, 'promptSHA256': sha(prompt_bytes), 'pages': selected,
                'images': {str(p): sha((args.images / f'upright-{p:02}.jpg').read_bytes()) for p in selected},
                'temperature': 0, 'thinkingLevel': 'low', 'maxOutputTokens': 24000, 'primaryAnswersIncluded': False}
    manifest_path = args.output / 'input-manifest.json'
    if manifest_path.exists() and json.loads(manifest_path.read_text()) != manifest:
        raise ValueError('Output directory belongs to different inputs/configuration')
    save(manifest_path, manifest)
    key = read_key()

    def run(page):
        output = args.output / f'page-{page:02}.json'
        if output.exists():
            existing = json.loads(output.read_text())
            if existing.get('finishReason') == 'STOP':
                validate(existing['result'])
                return {'page': page, 'rows': len(existing['result']['rows']), 'cached': True}
        for attempt in range(1, 3):
            attempt_dir = args.output / f'page-{page:02}-attempt-{int(time.time() * 1000)}'
            attempt_dir.mkdir()
            try:
                response = request(key, args.model, prompt_bytes.decode(),
                                   (args.images / f'upright-{page:02}.jpg').read_bytes(), attempt_dir / 'stream.txt')
                save(attempt_dir / 'response.json', response)
                if response['finishReason'] != 'STOP':
                    raise ValueError('Response did not finish normally')
                result = strict_loads(response['rawContent'])
                validate(result)
                response['result'] = result
                response['page'] = page
                save(output, response)
                stats = {'page': page, 'rows': len(result['rows']), 'issues': sum(len(r['issues']) for r in result['rows']),
                         'pageIssues': len(result['pageIssues']), 'seconds': response['seconds']}
                print(json.dumps(stats), flush=True)
                return stats
            except urllib.error.HTTPError as error:
                # No provider bodies, request headers or signed URLs in diagnostics.
                reason = f'HTTP {error.code}'
                save(attempt_dir / 'error.json', {'error': reason})
                if error.code not in (408, 429, 500, 502, 503, 504) or attempt == 2:
                    raise RuntimeError(reason) from None
                time.sleep(3 * attempt)
            except Exception as error:
                reason = str(error).replace(key, '[REDACTED]')[:300]
                save(attempt_dir / 'error.json', {'type': type(error).__name__, 'error': reason})
                if attempt == 2:
                    raise RuntimeError(reason) from None
        raise RuntimeError('No completed attempt')

    # Fail fast for configuration/authentication before dispatching the batch.
    results = [run(selected[0])]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(run, p): p for p in selected[1:]}
        for job in as_completed(jobs):
            try:
                results.append(job.result())
            except Exception as error:
                failure = {'page': jobs[job], 'error': str(error).replace(key, '[REDACTED]')[:300]}
                results.append(failure)
                print(json.dumps(failure), flush=True)
    save(args.output / 'run-summary.json', {'pages': sorted(results, key=lambda p: p['page']),
                                          'complete': all('error' not in r for r in results)})


if __name__ == '__main__':
    main()

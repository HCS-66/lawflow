"""Bounded whole-page account recovery; no proposed values or gold answers in input."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
from experimentIndependentKeys import request, save
from experimentThreePassStatement import read_key


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--images', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pages', required=True)
    parser.add_argument('--prompt', type=Path, default=Path('scripts/prompts/geminiFocusedAccountsV2.txt'))
    args = parser.parse_args()
    pages = [int(x) for x in args.pages.split(',')]
    args.output.mkdir(parents=True, exist_ok=True)
    prompt = args.prompt.read_text()
    model = 'gemini-3.8-flash'
    key = read_key()
    manifest = {'model': model, 'promptSHA256': hashlib.sha256(prompt.encode()).hexdigest(),
      'scope': ['accountNumber'], 'otherAnswersIncluded': False,
      'images': {str(p): hashlib.sha256((args.images / f'upright-{p:02}.jpg').read_bytes()).hexdigest() for p in pages}}
    manifest_path = args.output / 'manifest.json'
    if manifest_path.exists() and json.loads(manifest_path.read_text()) != manifest:
        raise ValueError('Recovery input mismatch; use another output directory')
    save(manifest_path, manifest)
    def run(page):
        cached = args.output / f'page-{page:02}.json'
        if cached.exists() and json.loads(cached.read_text()).get('finishReason') == 'STOP':
            return
        response = request(key, model, prompt, (args.images / f'upright-{page:02}.jpg').read_bytes(), args.output / f'page-{page:02}-stream.txt')
        save(args.output / f'page-{page:02}-response.json', response)
        if response['finishReason'] != 'STOP': raise ValueError('Incomplete response')
        result = json.loads(response['rawContent'])
        if not isinstance(result.get('bankName'), str) or not isinstance(result.get('identifiers'), list) or not isinstance(result.get('issues'), list): raise ValueError('Invalid recovery structure')
        for identifier in result['identifiers']:
            if identifier.get('role') not in ('account', 'card') or identifier.get('scope') not in ('header', 'transaction_column', 'account_information'): raise ValueError('Invalid identifier role or scope')
            if not isinstance(identifier.get('characters'), list) or any(not isinstance(c, str) or len(c) != 1 for c in identifier['characters']): raise ValueError('Invalid character sequence')
            if ''.join(identifier['characters']) != identifier.get('value'): raise ValueError('Character sequence disagrees with account')
            if not isinstance(identifier.get('uncertainPositions'), list): raise ValueError('Missing uncertainty positions')
        save(args.output / f'page-{page:02}.json', {'page': page, 'result': result, 'finishReason': response['finishReason'], 'seconds': response['seconds'], 'usage': response['usage']})
        print(json.dumps({'page': page, 'identifiers': len(result['identifiers']), 'issues': len(result['issues']), 'seconds': response['seconds']}), flush=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        jobs = [pool.submit(run, p) for p in pages]
        for job in as_completed(jobs): job.result()


if __name__ == '__main__': main()

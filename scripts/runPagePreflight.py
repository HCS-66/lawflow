"""Gemini full-page blank/orientation detection with immutable input provenance."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import io
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

from pypdf import PdfReader
from PIL import Image
from experimentIndependentKeys import save
from experimentThreePassStatement import read_key
from prepareQualityPages import prepare
from qualityPagePreflight import POLICY_VERSION, decide, image_metrics, validate_classification
from strictModelJson import loads


def sha(value):
    return hashlib.sha256(value).hexdigest()


def request(key, model, prompt, image, four_views=False):
    parts = [{'text': prompt}]
    if four_views:
        with Image.open(io.BytesIO(image)) as original:
            for name, angle in zip('ABCD', (0, 90, 180, 270)):
                buffer = io.BytesIO()
                original.rotate(-angle, expand=True).save(buffer, format='JPEG', quality=95)
                parts.extend([{'text': '候选' + name}, {'inlineData': {'mimeType': 'image/jpeg',
                  'data': base64.b64encode(buffer.getvalue()).decode()}}])
    else:
        parts.append({'inlineData': {'mimeType': 'image/jpeg', 'data': base64.b64encode(image).decode()}})
    payload = {'contents': [{'role': 'user', 'parts': parts}],
        'generationConfig': {'temperature': 0, 'thinkingConfig': {'thinkingLevel': 'low'},
                             'responseMimeType': 'application/json', 'maxOutputTokens': 2048}}
    req = urllib.request.Request(f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
        data=json.dumps(payload, ensure_ascii=False).encode(), method='POST',
        headers={'Content-Type': 'application/json', 'x-goog-api-key': key})
    with urllib.request.urlopen(req, timeout=120) as response:
        data = json.load(response)
    candidate = data.get('candidates', [{}])[0]
    if candidate.get('finishReason') != 'STOP':
        raise ValueError('Preflight response did not finish normally')
    content = ''.join(p.get('text', '') for p in candidate.get('content', {}).get('parts', []) if not p.get('thought'))
    result = loads(content)
    selection = None
    if four_views:
        if (not isinstance(result, dict) or set(result) != {'pageKind', 'uprightCandidate', 'reason'}
            or result['uprightCandidate'] not in ('A', 'B', 'C', 'D', 'uncertain')):
            raise ValueError('Invalid orientation candidate selection')
        selection = result['uprightCandidate']
        result = {'pageKind': result['pageKind'], 'clockwiseRotation':
          None if result['pageKind'] == 'blank' else {'A': 0, 'B': 90, 'C': 180, 'D': 270, 'uncertain': None}[selection],
          'reason': result['reason']}
    validate_classification(result)
    return {'result': result, 'uprightCandidate': selection, 'finishReason': 'STOP', 'usage': data.get('usageMetadata'), 'model': model}


def run_preflight(pdf, images, output, workers=4, four_views=False):
    pdf, images, output = Path(pdf), Path(images), Path(output)
    output.mkdir(parents=True, exist_ok=True)
    if not images.exists():
        prepare(pdf, images, dpi=150)
    render = json.loads((images / 'render-manifest.json').read_text())
    reader = PdfReader(pdf)
    numbers = list(range(1, len(reader.pages) + 1))
    if (render['sourceSHA256'] != sha(pdf.read_bytes()) or render['pages'] != numbers
        or render['crop'] or any(render['extraClockwiseRotation'].values())):
        raise ValueError('Preflight requires all original full-page renders without extra rotations')
    prompt = Path('scripts/prompts/geminiPagePreflightV2.txt' if four_views else 'scripts/prompts/geminiPagePreflightV1.txt').read_bytes()
    model = 'gemini-3.8-flash'
    manifest = {'policyVersion': POLICY_VERSION, 'policySHA256': sha(Path('scripts/qualityPagePreflight.py').read_bytes()),
      'sourceSHA256': render['sourceSHA256'], 'model': model, 'promptSHA256': sha(prompt), 'pages': numbers,
      'images': {str(p): sha((images / f'upright-{p:02}.jpg').read_bytes()) for p in numbers},
      'standardAnswersRead': False, 'temperature': 0, 'thinkingLevel': 'low', 'maxOutputTokens': 2048}
    if four_views:
        manifest['orientationMode'] = 'FOUR_FULL_PAGE_CANDIDATES'
    path = output / 'input-manifest.json'
    if path.exists() and json.loads(path.read_text()) != manifest:
        raise ValueError('Preflight inputs changed; use a new output directory')
    save(path, manifest)
    key = read_key()
    texts = {p: bool(reader.pages[p - 1].extract_text().strip()) for p in numbers}

    def run(page):
        image = images / f'upright-{page:02}.jpg'
        cached = output / f'page-{page:02}.json'
        started = time.monotonic()
        response = None
        if cached.exists():
            response = json.loads(cached.read_text())
            validate_classification(response['result'])
            if response.get('finishReason') != 'STOP':
                response = None
        for attempt in range(1, 4):
            if response is not None:
                break
            try:
                response = request(key, model, prompt.decode(), image.read_bytes(), four_views=four_views)
                response['seconds'] = round(time.monotonic() - started, 2)
                save(cached, response)
            except Exception as error:
                reason = f'HTTP {error.code}' if isinstance(error, urllib.error.HTTPError) else type(error).__name__ + ': ' + str(error)
                save(output / f'page-{page:02}-attempt-{attempt}-{time.time_ns()}.error.json',
                     {'error': reason.replace(key, '[REDACTED]')[:200]})
                if attempt == 3 or (isinstance(error, urllib.error.HTTPError) and error.code in (401, 403)):
                    raise RuntimeError(f'Page {page}: {reason[:100]}') from None
                time.sleep(attempt * 2)
        metrics = image_metrics(image)
        result = {'page': page, 'classification': response['result'], 'metrics': metrics,
          'decision': decide(response['result'], metrics, texts[page]),
          'imageSHA256': manifest['images'][str(page)], 'responseSHA256': sha(cached.read_bytes())}
        print(json.dumps({'page': page, **result['decision']}, ensure_ascii=False), flush=True)
        return result

    results, failures = [run(numbers[0])], []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        jobs = {pool.submit(run, page): page for page in numbers[1:]}
        for job in as_completed(jobs):
            try:
                results.append(job.result())
            except Exception as error:
                failures.append({'page': jobs[job], 'error': str(error).replace(key, '[REDACTED]')[:200]})
    complete = not failures and len(results) == len(numbers)
    plan = {'policyVersion': POLICY_VERSION, 'sourceSHA256': render['sourceSHA256'], 'totalPages': len(numbers),
      'complete': complete, 'pages': sorted(results, key=lambda p: p['page']), 'failures': failures,
      'standardAnswersRead': False, 'crop': False, 'originalPageNumbersPreserved': True}
    save(output / 'plan.json', plan)
    if not complete:
        raise RuntimeError('Incomplete preflight; failures retained, no pages silently omitted')
    return plan


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--images', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--four-views', action='store_true')
    args = parser.parse_args()
    plan = run_preflight(args.pdf, args.images, args.output, args.workers, args.four_views)
    print(json.dumps({'total': plan['totalPages'], 'blankSkipped': sum(p['decision']['blankConfirmed'] for p in plan['pages']),
                      'rotated': sum(bool(p['decision']['clockwiseRotation']) for p in plan['pages'])}))

"""Score every frozen document, including failed documents. Never participates in recognition."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--suite', type=Path, required=True)
    parser.add_argument('--gold-directory', type=Path, default=Path('test-data/recognition'))
    parser.add_argument('--name', default='acceptance')
    args = parser.parse_args()
    destination = args.suite / f'{args.name}-summary.json'
    if destination.exists():
        raise ValueError('Suite evaluation is frozen; choose a different name')
    documents = sorted(p for p in args.suite.iterdir() if p.is_dir() and p.name.isdigit())
    frozen = {p.name: hashlib.sha256((p / 'delivery/result.json').read_bytes()).hexdigest()
              if (p / 'delivery/result.json').exists() else None for p in documents}
    (args.suite / f'{args.name}-prediction-freeze.json').write_text(json.dumps(frozen, indent=2))
    reports = []
    for p in documents:
        gold = next(args.gold_directory.glob(p.name + '-*-标准流水.csv'))
        if frozen[p.name] is None:
            with gold.open(encoding='utf-8-sig', newline='') as stream:
                expected = len(list(csv.DictReader(stream)))
            reports.append({'document': p.name, 'processingComplete': False, 'expectedRows': expected,
                'outputRows': 0, 'correctRows': 0, 'manualRows': expected, 'criticalErrorCount': expected,
                'unalertedCriticalErrorCount': expected, 'blindAcceptancePassed': False, 'failure': 'No completed delivery'})
            continue
        subprocess.run(['python3', 'scripts/evaluateQualityTrial.py', '--trial', str(p / 'delivery'),
            '--gold', str(gold), '--profile', 'enforcement', '--name', args.name], check=True, stdout=subprocess.DEVNULL)
        report = json.loads((p / 'delivery' / f'{args.name}.json').read_text())
        if hashlib.sha256((p / 'delivery/result.json').read_bytes()).hexdigest() != frozen[p.name]:
            raise ValueError('Frozen predictions changed during scoring')
        reports.append({'document': p.name, 'processingComplete': report['protocol']['processingComplete'], **report})
    total = {key: sum(r[key] for r in reports) for key in ['expectedRows', 'outputRows', 'correctRows',
        'manualRows', 'criticalErrorCount', 'unalertedCriticalErrorCount']}
    denominator = sum(max(r['expectedRows'], r['outputRows']) for r in reports)
    total['initialCriticalAccuracy'] = total['correctRows'] / denominator if denominator else None
    total['manualReviewRate'] = total['manualRows'] / total['expectedRows'] if total['expectedRows'] else None
    total['processingComplete'] = all(r['processingComplete'] for r in reports)
    total['observedThresholdsMet'] = bool(total['processingComplete'] and total['initialCriticalAccuracy'] is not None
        and total['initialCriticalAccuracy'] >= .995 and total['manualReviewRate'] <= .05 and not total['unalertedCriticalErrorCount'])
    total['blindAcceptancePassed'] = False
    report = {'profile': 'ENFORCEMENT_V1', 'protocol': 'REGRESSION', 'totals': total, 'documents': reports,
        'limitations': ['Existing same-case development files, not independent blind data.',
            'Source alignment is diagnostic, not independently annotated.',
            'Aggregate thresholds do not imply every small document has <=5% manual work.']}
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(total, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

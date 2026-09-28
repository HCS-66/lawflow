"""Freeze one complete-document prediction, then compare with several private truth CSVs."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

from experimentQwenStage2Verbatim import COLUMNS


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--trial', type=Path, required=True, help='Finalized delivery directory')
    parser.add_argument('--gold-directory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    frozen = (args.trial / 'result.json').read_bytes()
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / 'result.json').write_bytes(frozen)
    if (args.trial / 'registry.json').exists():
        shutil.copy2(args.trial / 'registry.json', args.output / 'registry.json')
    fingerprint = hashlib.sha256(frozen).hexdigest()
    (args.output / 'prediction-freeze.json').write_text(json.dumps({'predictionSHA256': fingerprint,
        'sourceTrial': str(args.trial.resolve()), 'protocol': 'REGRESSION',
        'independentSourceAlignmentVerified': False}, indent=2))
    # Truth is opened only after the prediction and generated alerts are frozen.
    sources, rows, row_map = [], [], []
    for path in sorted(args.gold_directory.glob('*-标准流水.csv')):
        with path.open(encoding='utf-8-sig', newline='') as stream:
            reader = csv.DictReader(stream)
            if reader.fieldnames != COLUMNS:
                raise ValueError('Truth CSV does not follow the exact 12-column contract')
            for local, row in enumerate(reader, 1):
                if set(row) != set(COLUMNS) or any(row[c] is None for c in COLUMNS):
                    raise ValueError('Malformed truth row')
                rows.append([row[c] for c in COLUMNS])
                row_map.append({'expectedId': f'G{len(rows)}', 'sourceFile': path.name, 'localTransaction': local})
        sources.append({'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    if not sources:
        raise ValueError('No truth CSVs selected')
    combined = args.output / 'combined-truth.csv'
    with combined.open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.writer(stream); writer.writerow(COLUMNS); writer.writerows(rows)
    (args.output / 'truth-provenance.json').write_text(json.dumps({'sources': sources, 'rows': row_map}, ensure_ascii=False, indent=2))
    subprocess.run(['python3', 'scripts/evaluateQualityTrial.py', '--trial', str(args.output), '--gold', str(combined),
                    '--profile', 'enforcement', '--name', 'acceptance'], check=True)
    if hashlib.sha256((args.trial / 'result.json').read_bytes()).hexdigest() != fingerprint:
        raise ValueError('Original prediction changed while evaluating')


if __name__ == '__main__': main()

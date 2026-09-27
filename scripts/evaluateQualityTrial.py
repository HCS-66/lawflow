"""Freeze predictions first, then score against human CSV. Diagnostic alignment is not blind certification."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import subprocess
from collections import defaultdict

from evaluateStatementUncertainty import align_rows
from experimentQwenStage2Verbatim import COLUMNS


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--trial', type=Path, required=True)
    parser.add_argument('--gold', type=Path, required=True)
    parser.add_argument('--name', default='evaluation')
    parser.add_argument('--profile', choices=['funds', 'enforcement'], default='funds')
    args = parser.parse_args()
    result_path = args.trial / 'result.json'
    frozen_bytes = result_path.read_bytes()
    frozen_hash = hashlib.sha256(frozen_bytes).hexdigest()
    result = json.loads(frozen_bytes)
    if not args.name.replace('-', '').replace('_', '').isalnum():
        raise ValueError('Invalid evaluation name')
    target = args.trial / f'{args.name}-input.json'
    if target.exists():
        raise ValueError('Evaluation already exists; use a new frozen trial for further iterations')
    # No standard answers were available to this run's model, assembly or alert generator.
    with args.gold.open(encoding='utf-8-sig', newline='') as stream:
        gold = [[row[c] for c in COLUMNS] for row in csv.DictReader(stream)]
    predicted = [r['values'] for r in result['rows']]
    alignment, methods = align_rows(gold, predicted)
    # A clipped owner account AND clipped date cannot be aligned by either field.
    # Add only mutually unique cash/direction anchors, kept explicitly diagnostic.
    left, right = defaultdict(list), defaultdict(list)
    used = set(alignment.values())
    for i, row in enumerate(gold):
        if i not in alignment and all(row[f] for f in (5, 6, 7)):
            left[tuple(row[f] for f in (5, 6, 7))].append(i)
    for j, row in enumerate(predicted):
        if j not in used and all(row[f] for f in (5, 6, 7)):
            right[tuple(row[f] for f in (5, 6, 7))].append(j)
    for key, indices in left.items():
        if len(indices) == 1 and len(right[key]) == 1:
            alignment[indices[0]] = right[key][0]
            methods['unique_direction_amount_balance_diagnostic'] += 1
    left, right = defaultdict(list), defaultdict(list)
    used = set(alignment.values())
    for i, row in enumerate(gold):
        if i not in alignment and all(row[f] for f in (4, 6, 7)):
            left[tuple(row[f] for f in (4, 6, 7))].append(i)
    for j, row in enumerate(predicted):
        if j not in used and all(row[f] for f in (4, 6, 7)):
            right[tuple(row[f] for f in (4, 6, 7))].append(j)
    for key, indices in left.items():
        if len(indices) == 1 and len(right[key]) == 1:
            alignment[indices[0]] = right[key][0]
            methods['unique_date_amount_balance_diagnostic'] += 1
    expected = []
    for i, values in enumerate(gold):
        # These borrowed locators are ONLY diagnostic; sourceAlignmentVerified is always false.
        refs = result['rows'][alignment[i]]['sourceObservationIds'] if i in alignment else []
        expected.append({'id': f'G{i+1}', 'values': values, 'sourceObservationIds': refs})
    alerts = [{'id': f'A{i+1}', 'rowIds': [result['rows'][r-1]['id'] for r in issue['outputRows']],
               'sourceObservationIds': [f'source:{r}' for r in issue['sourceRows']],
               'fields': [issue['field'] or 'ROW'], 'reason': issue['message'],
               'required': issue['severity'] != 'ADVISORY'} for i, issue in enumerate(result['pending'])]
    payload = {'expected': expected, 'actual': result['rows'], 'profile': args.profile,
               'alignment': [{'expectedId': f'G{i+1}', 'actualId': result['rows'][j]['id']} for i,j in alignment.items()],
               'alerts': alerts,
               'protocol': {'kind': 'REGRESSION', 'annotationsComplete': True, 'sourceAlignmentVerified': False,
                            'predictionsFrozenBeforeEvaluation': True, 'processingComplete': result['complete']},
               'predictionSHA256': frozen_hash, 'goldSHA256': hashlib.sha256(args.gold.read_bytes()).hexdigest(),
               'alignmentMethods': dict(methods),
               'limitations': ['Existing development document; not a new blind case.',
                              'Alignment uses unique value combinations; source positions are not independently annotated.',
                              'All complete dates and names without a counterparty account are treated as critical in this diagnostic.']}
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    subprocess.run(['node_modules/.bin/tsx', 'scripts/scoreQualityTrial.ts', str(target), str(args.trial / f'{args.name}.json')], check=True)
    if hashlib.sha256(result_path.read_bytes()).hexdigest() != frozen_hash:
        raise ValueError('Frozen predictions changed during evaluation')


if __name__ == '__main__':
    main()

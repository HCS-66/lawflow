"""Evaluate already-frozen review signals; gold is never used to generate alerts."""

import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import json
from pathlib import Path

from checkStatementUncertainty import CRITICAL
from experimentQwenStage2Verbatim import COLUMNS


def align_rows(gold, result):
    alignment, used, methods = {}, set(), Counter()
    keys = [
        ('core', (0, 6, 7)),
        ('account_date_direction_counterparty', (0, 4, 5, 10)),
        ('account_date_direction_amount', (0, 4, 5, 6)),
        ('date_direction_amount_balance', (4, 5, 6, 7)),
    ]
    for name, fields in keys:
        gindex, rindex = defaultdict(list), defaultdict(list)
        for gi, row in enumerate(gold):
            if gi not in alignment:
                gindex[tuple(row[f] for f in fields)].append(gi)
        for ri, row in enumerate(result):
            if ri not in used:
                rindex[tuple(row[f] for f in fields)].append(ri)
        for key, indices in gindex.items():
            if len(indices) == 1 and len(rindex[key]) == 1:
                gi, ri = indices[0], rindex[key][0]
                alignment[gi] = ri
                used.add(ri)
                methods[name] += 1
    return alignment, methods


def rate(n, d):
    return {'count': n, 'total': d, 'percent': round(100 * n / d, 2) if d else None}


def evaluate(root, gold_path, signals_name='review-signals.json', output_prefix='evaluation'):
    frozen = root / signals_name
    frozen_hash = hashlib.sha256(frozen.read_bytes()).hexdigest()
    review = json.loads(frozen.read_text())
    with gold_path.open(encoding='utf-8-sig', newline='') as stream:
        gold = [[row[c] for c in COLUMNS] for row in csv.DictReader(stream)]
    actual = [row['values'] for row in review['rows']]
    alignment, methods = align_rows(gold, actual)
    differences = []
    wrong_rows, key_wrong_rows = set(), set()
    for gi, ri in alignment.items():
        for f in range(12):
            if gold[gi][f] != actual[ri][f]:
                issues = review['rows'][ri]['issues']
                wrong_rows.add(ri)
                if f in CRITICAL:
                    key_wrong_rows.add(ri)
                differences.append({'goldRow': gi + 1, 'outputRow': ri + 1, 'field': COLUMNS[f],
                                    'fieldIndex': f, 'gold': gold[gi][f], 'actual': actual[ri][f],
                                    'critical': f in CRITICAL,
                                    'anyRowAlert': review['rows'][ri]['needsReview'],
                                    'priorityRowAlert': review['rows'][ri]['priorityReview'],
                                    'directFieldAlert': any(i['field'] == f for i in issues),
                                    'directFieldStages': sorted({i['stage'] for i in issues if i['field'] == f})})
    flagged = {i for i, r in enumerate(review['rows']) if r['needsReview']}
    priority = {i for i, r in enumerate(review['rows']) if r['priorityReview']}
    aligned_output = set(alignment.values())
    def detection(selected):
        return {'reviewLoad': rate(len(selected), len(actual)),
                'wrongRowRecall': rate(len(wrong_rows & selected), len(wrong_rows)),
                'criticalWrongRowRecall': rate(len(key_wrong_rows & selected), len(key_wrong_rows)),
                'strictErrorPrecisionOnAligned': rate(len(wrong_rows & selected), len(aligned_output & selected)),
                'unflaggedWrongRows': len(wrong_rows - selected),
                'unflaggedCriticalWrongRows': len(key_wrong_rows - selected)}
    stages = {}
    for name in ('stage1', 'stage2', 'program'):
        selection = {i for i, r in enumerate(review['rows']) if any(issue['stage'] == name for issue in r['issues'])}
        stages[name] = detection(selection)
    confidence = {}
    for label in ('high', 'medium', 'low'):
        selection = {i for i, r in enumerate(review['rows']) if r['confidence'] == label}
        confidence[label] = {'rows': len(selection), 'aligned': len(selection & aligned_output),
                             'wrongRows': len(selection & wrong_rows), 'criticalWrongRows': len(selection & key_wrong_rows)}
    nonempty = [gi for gi in alignment if gold[gi][10]]
    report = {
        'goldRows': len(gold), 'resultRows': len(actual), 'alignedRows': len(alignment),
        'alignmentMethods': dict(methods), 'unmatchedGoldRows': [i + 1 for i in range(len(gold)) if i not in alignment],
        'unmatchedOutputRows': [i + 1 for i in range(len(actual)) if i not in aligned_output],
        'exact12Multiset': sum((Counter(map(tuple, gold)) & Counter(map(tuple, actual))).values()),
        'fieldCorrectOnAligned': {c: rate(sum(gold[gi][f] == actual[ri][f] for gi, ri in alignment.items()), len(alignment)) for f, c in enumerate(COLUMNS)},
        'nonemptyCounterpartyAccountCorrectOnAligned': rate(sum(gold[gi][10] == actual[alignment[gi]][10] for gi in nonempty), len(nonempty)),
        'wrongRows': len(wrong_rows), 'criticalWrongRows': len(key_wrong_rows),
        'allAlerts': detection(flagged), 'priorityAlerts': detection(priority), 'byAlertStage': stages,
        'directFieldRecall': rate(sum(d['directFieldAlert'] for d in differences), len(differences)),
        'criticalDirectFieldRecall': rate(sum(d['directFieldAlert'] for d in differences if d['critical']), sum(d['critical'] for d in differences)),
        'stage2SelfConfidence': confidence,
        'pageFlags': review['pageFlags'],
        'reviewSignalsSHA256BeforeGoldEvaluation': frozen_hash,
        'reviewSignalsUnchanged': frozen_hash == hashlib.sha256(frozen.read_bytes()).hexdigest(),
        'criticalFields': [COLUMNS[i] for i in sorted(CRITICAL)],
        'limits': 'Detection is scored on uniquely aligned transactions only. Unmatched rows are reported separately. Text/type differences include normalization choices, not exclusively OCR errors. Stage flags do not prove independent original-image completeness.'}
    (root / f'{output_prefix}.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    (root / f'{output_prefix}-differences.json').write_text(json.dumps(differences, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--gold', type=Path, required=True)
    parser.add_argument('--signals-name', default='review-signals.json')
    parser.add_argument('--output-prefix', default='evaluation')
    args = parser.parse_args()
    evaluate(args.root, args.gold, args.signals_name, args.output_prefix)

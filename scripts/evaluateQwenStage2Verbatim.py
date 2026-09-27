"""Compare text-only stage-2 CSV with the private checked statement."""

import argparse
import collections
import csv
import json
from pathlib import Path


def read_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as file:
        return list(csv.DictReader(file))


def key(row):
    return row["accountNumber"], row["amount"], row["balance"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--gold", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = read_csv(args.result)
    gold = read_csv(args.gold)
    by_key = {key(row): row for row in gold}
    matched = [(row, by_key[key(row)]) for row in result if key(row) in by_key]
    unmatched_result = [row for row in result if key(row) not in by_key]
    result_keys = collections.Counter(key(row) for row in result)
    missing_gold = [row for row in gold if not result_keys[key(row)]]
    columns = list(gold[0])
    report = {
        "resultRows": len(result),
        "goldRows": len(gold),
        "matchedCoreRows": len(matched),
        "missingGoldCore": len(missing_gold),
        "unmatchedResultCore": len(unmatched_result),
        "duplicateResultCore": sum(count - 1 for count in result_keys.values() if count > 1),
        "exact12Rows": sum(all(actual[column] == expected[column] for column in columns)
                           for actual, expected in matched),
        "fieldAccuracyOnCoreMatched": {
            column: {"correct": sum(actual[column] == expected[column] for actual, expected in matched),
                     "total": len(matched)} for column in columns
        },
        "typeConfusions": collections.Counter(
            f"{expected['transactionType']} => {actual['transactionType']}"
            for actual, expected in matched if actual["transactionType"] != expected["transactionType"]
        ).most_common(20),
        "missingGoldKeys": [key(row) for row in missing_gold],
        "unmatchedResultKeys": [key(row) for row in unmatched_result],
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k not in ("missingGoldKeys", "unmatchedResultKeys")},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

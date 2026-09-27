"""Measure whether literal first-pass rows contain every gold transaction."""

import argparse
from collections import Counter, defaultdict
import csv
import json
from pathlib import Path


ANCHOR_FIELDS = ("accountNumber", "transactionDate", "amount", "balance")
CORE_FIELDS = ("accountNumber", "transactionDate", "direction", "amount", "balance")


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as file:
        return list(csv.DictReader(file))


def derive_directions(rows):
    known = defaultdict(set)
    for row in rows:
        marker = row.get("rawDirectionMarker", "").strip()
        direction = row.get("direction", "")
        if direction not in ("IN", "OUT"):
            direction = "IN" if marker.startswith("+") else "OUT" if marker.startswith("-") else ""
        row["_direction"] = direction
        if direction:
            known[tuple(row.get(field, "") for field in ANCHOR_FIELDS)].add(direction)
    votes = defaultdict(Counter)
    for row in rows:
        marker = row.get("rawDirectionMarker", "").strip()
        if marker not in ("1", "2"):
            continue
        direction = row["_direction"]
        if not direction:
            matches = known[tuple(row.get(field, "") for field in ANCHOR_FIELDS)]
            direction = next(iter(matches)) if len(matches) == 1 else ""
        if direction:
            votes[marker][direction] += 1
    code_map = {}
    for marker, counts in votes.items():
        ordered = counts.most_common()
        if len(ordered) == 1 or ordered[0][1] > ordered[1][1]:
            code_map[marker] = ordered[0][0]
    for row in rows:
        if not row["_direction"]:
            row["_direction"] = code_map.get(row.get("rawDirectionMarker", "").strip(), "")
    return code_map


def core(row):
    return tuple(row.get("_direction", row.get("direction", "")) if field == "direction" else row.get(field, "") for field in CORE_FIELDS)


def anchor(row):
    return tuple(row.get(field, "") for field in ANCHOR_FIELDS)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", required=True)
    parser.add_argument("--gold", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    rows = read_csv(args.raw)
    gold = read_csv(args.gold)
    code_map = derive_directions(rows)
    actual_anchors = Counter(map(anchor, rows))
    actual_core = Counter(map(core, rows))
    gold_anchors = Counter(map(anchor, gold))
    gold_core = Counter(map(core, gold))
    presence_key = lambda row: (row.get("accountNumber", ""), row.get("amount", ""), row.get("balance", "").lstrip("-"))
    actual_presence = Counter(map(presence_key, rows))
    gold_presence = Counter(map(presence_key, gold))
    transaction_present = sum(min(count, actual_presence[key]) for key, count in gold_presence.items())
    anchor_covered = sum(min(count, actual_anchors[key]) for key, count in gold_anchors.items())
    core_covered = sum(min(count, actual_core[key]) for key, count in gold_core.items())
    by_core = defaultdict(list)
    by_presence = defaultdict(list)
    for row in rows:
        by_core[core(row)].append(row)
        by_presence[presence_key(row)].append(row)
    missing = []
    for gold_row in gold:
        key = core(gold_row)
        if not by_core[key]:
            alternatives = [row for row in rows if row.get("accountNumber") == gold_row["accountNumber"] and row.get("amount") == gold_row["amount"] and (
                row.get("balance", "").lstrip("-") == gold_row["balance"].lstrip("-")
                or row.get("transactionDate") == gold_row["transactionDate"]
            )]
            missing.append({"gold": {field: gold_row[field] for field in CORE_FIELDS}, "nearbyRaw": [{field: row.get("_direction", "") if field == "direction" else row.get(field, "") for field in CORE_FIELDS} for row in alternatives[:5]]})
    time_total = time_found = account_total = account_found = merchant_total = merchant_found = 0
    transfer_total = transfer_account_found = transfer_name_found = 0
    tracked_total = tracked_account_found = tracked_name_found = 0
    outgoing_total = outgoing_account_found = 0
    consumer_total = consumer_merchant_found = 0
    for gold_row in gold:
        evidence = by_core[core(gold_row)]
        transaction_evidence = by_presence[presence_key(gold_row)]
        if gold_row["transactionTime"]:
            time_total += 1
            time_found += any(row.get("transactionTime") == gold_row["transactionTime"] for row in evidence)
        if gold_row["counterpartyAccount"]:
            account_total += 1
            account_found += any(row.get("counterpartyAccount") == gold_row["counterpartyAccount"] for row in evidence)
        if gold_row["transactionType"] in ("消费", "退款", "缴费", "第三方支付") and gold_row["counterpartyName"]:
            merchant_total += 1
            merchant_found += any(row.get("rawMerchant") == gold_row["counterpartyName"] for row in evidence)
            consumer_total += 1
            consumer_merchant_found += any(row.get("rawMerchant") == gold_row["counterpartyName"] for row in transaction_evidence)
        if gold_row["direction"] == "OUT" and gold_row["counterpartyAccount"]:
            outgoing_total += 1
            outgoing_account_found += any(row.get("counterpartyAccount") == gold_row["counterpartyAccount"] for row in transaction_evidence)
            if gold_row["transactionType"] in ("账户转账", "贷款还款", "信用卡还款", "司法扣划"):
                tracked_total += 1
                tracked_account_found += any(row.get("counterpartyAccount") == gold_row["counterpartyAccount"] for row in transaction_evidence)
                tracked_name_found += any(gold_row["counterpartyName"] in (row.get("counterpartyName", ""), row.get("rawCounterpartyName", ""), row.get("rawMerchant", ""), row.get("bankName", "")) for row in transaction_evidence)
            if gold_row["transactionType"] == "账户转账":
                transfer_total += 1
                transfer_account_found += any(row.get("counterpartyAccount") == gold_row["counterpartyAccount"] for row in transaction_evidence)
                transfer_name_found += any(gold_row["counterpartyName"] in (row.get("counterpartyName", ""), row.get("rawCounterpartyName", ""), row.get("rawMerchant", "")) for row in transaction_evidence)
    report = {
        "rawRows": len(rows), "goldRows": len(gold), "directionCodeMapFromRaw": code_map,
        "unknownDirectionRows": sum(not row["_direction"] for row in rows),
        "transactionPresence": {"found": transaction_present, "total": len(gold), "goldFingerprintCollisions": sum(count - 1 for count in gold_presence.values() if count > 1)},
        "anchorCoverage4Fields": {"found": anchor_covered, "total": len(gold)},
        "coreCoverage5Fields": {"found": core_covered, "total": len(gold)},
        "exactTimeEvidence": {"found": time_found, "total": time_total},
        "exactCounterpartyAccountEvidence": {"found": account_found, "total": account_total},
        "exactMerchantEvidence": {"found": merchant_found, "total": merchant_total},
        "priorityMetrics": {
            "outgoingTransferExactCounterpartyAccount": {"found": transfer_account_found, "total": transfer_total},
            "outgoingTransferAnyCorrectName": {"found": transfer_name_found, "total": transfer_total},
            "trackedOutflowsExactCounterpartyAccount": {"found": tracked_account_found, "total": tracked_total},
            "trackedOutflowsAnyCorrectName": {"found": tracked_name_found, "total": tracked_total},
            "allOutgoingExactCounterpartyAccount": {"found": outgoing_account_found, "total": outgoing_total},
            "consumerExactMerchant": {"found": consumer_merchant_found, "total": consumer_total},
        },
        "missingCoreRows": missing,
    }
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "missingCoreRows"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

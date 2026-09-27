"""Score first-pass evidence against a manually checked 12-column statement."""

import argparse
from collections import Counter, defaultdict
import csv
import json
from pathlib import Path


def read_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as file:
        return list(csv.DictReader(file))


def fingerprint(row):
    return (row["accountNumber"], row["amount"], row["balance"].lstrip("-"))


def direction_code_map(rows):
    anchors = defaultdict(set)
    for row in rows:
        if row.get("direction") in ("IN", "OUT"):
            anchors[(row.get("accountNumber"), row.get("transactionDate"), row.get("amount"), row.get("balance"))].add(row["direction"])
    votes = defaultdict(Counter)
    for row in rows:
        marker = row.get("rawDirectionMarker", "")
        if marker not in ("1", "2"):
            continue
        value = row.get("direction", "")
        if value not in ("IN", "OUT"):
            possible = anchors[(row.get("accountNumber"), row.get("transactionDate"), row.get("amount"), row.get("balance"))]
            value = next(iter(possible)) if len(possible) == 1 else ""
        if value:
            votes[marker][value] += 1
    return {marker: tally.most_common(1)[0][0] for marker, tally in votes.items() if len(tally) == 1 or tally.most_common(2)[0][1] > tally.most_common(2)[1][1]}


def direction(row, code_map):
    value = row.get("direction", "")
    if value in ("IN", "OUT"):
        return value
    marker = row.get("rawDirectionMarker", "")
    return "IN" if marker.startswith("+") else "OUT" if marker.startswith("-") else code_map.get(marker, "")


def channel(row):
    value = row.get("paymentChannel", "")
    if value:
        return value
    merchant = row.get("rawMerchant", "")
    for known in ("抖音支付", "微信支付", "财付通", "支付宝", "程支付", "银联"):
        if merchant.startswith(known):
            return known
    return ""


def ratio(found, total):
    return {"found": found, "total": total, "percent": round(100 * found / total, 2) if total else None}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", required=True)
    parser.add_argument("--gold", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    raw, gold = read_rows(args.raw), read_rows(args.gold)
    code_map = direction_code_map(raw)
    by_fingerprint = defaultdict(list)
    for row in raw:
        by_fingerprint[fingerprint(row)].append(row)

    counts = Counter()
    missing = []
    wrong_counterparty_accounts = []
    for expected in gold:
        matches = by_fingerprint[fingerprint(expected)]
        counts["goldRows"] += 1
        kind = expected["transactionType"]
        direction_expected = expected["direction"]
        groups = []
        if kind == "账户转账" and direction_expected == "OUT":
            groups.append("outgoingTransfers")
        if kind == "账户转账" and direction_expected == "IN":
            groups.append("incomingTransfers")
        if kind == "信用卡还款" and direction_expected == "IN":
            groups.append("creditCardRepaymentSources")
        if kind in ("贷款放款", "贷款还款", "司法扣划") or (kind == "信用卡还款" and direction_expected == "OUT"):
            groups.append("otherAccountMovements")
        for group in groups:
            counts[group + "Total"] += 1
            counts[group + "AccountTotal"] += bool(expected["counterpartyAccount"])
            counts[group + "NameTotal"] += bool(expected["counterpartyName"])
        expected_channel = expected["counterpartyName"].split("-", 1)[0] if kind in ("消费", "退款", "缴费") and "-" in expected["counterpartyName"] else ""
        counts["merchantChannelTotal"] += bool(expected_channel)
        if not matches:
            missing.append({key: expected[key] for key in ("accountNumber", "transactionDate", "direction", "amount", "balance")})
            continue
        counts["present"] += 1
        same_core = [row for row in matches if row.get("transactionDate") == expected["transactionDate"] and direction(row, code_map) == expected["direction"] and row.get("balance") == expected["balance"]]
        counts["coreExact"] += bool(same_core)
        counts["dateExact"] += any(row.get("transactionDate") == expected["transactionDate"] for row in matches)
        counts["directionExact"] += any(direction(row, code_map) == expected["direction"] for row in matches)

        for group in groups:
            if expected["counterpartyAccount"]:
                counts[group + "AccountExact"] += any(row.get("counterpartyAccount") == expected["counterpartyAccount"] for row in matches)
            if expected["counterpartyName"]:
                counts[group + "NameExact"] += any(expected["counterpartyName"] in (row.get("counterpartyName", ""), row.get("rawCounterpartyName", "")) for row in matches)
            incorrect = sorted({row.get("counterpartyAccount", "") for row in matches if row.get("counterpartyAccount") and row.get("counterpartyAccount") != expected["counterpartyAccount"]})
            if incorrect:
                wrong_counterparty_accounts.append({"group": group, "date": expected["transactionDate"], "amount": expected["amount"], "expected": expected["counterpartyAccount"], "observedWrong": incorrect})

        if expected_channel:
            counts["merchantChannelExact"] += any(channel(row) == expected_channel for row in matches)

    groups = ("outgoingTransfers", "incomingTransfers", "creditCardRepaymentSources", "otherAccountMovements")
    report = {
        "rawObservationRows": len(raw), "goldUniqueRows": len(gold), "directionCodeMapFromRaw": code_map,
        "rowPresence": ratio(counts["present"], len(gold)),
        "coreExact": ratio(counts["coreExact"], len(gold)),
        "dateExactAmongPresent": ratio(counts["dateExact"], counts["present"]),
        "directionExactAmongPresent": ratio(counts["directionExact"], counts["present"]),
        "priorityCounterparties": {group: {
            "transactions": counts[group + "Total"],
            "exactAccount": ratio(counts[group + "AccountExact"], counts[group + "AccountTotal"]),
            "exactName": ratio(counts[group + "NameExact"], counts[group + "NameTotal"]),
        } for group in groups},
        "merchantPaymentChannel": ratio(counts["merchantChannelExact"], counts["merchantChannelTotal"]),
        "wrongPriorityCounterpartyAccountObservations": wrong_counterparty_accounts,
        "missingRows": missing,
        "method": "Gold rows are unique transactions. Raw PDF rows may repeat in multiple tables. Match by own account + amount + absolute balance, then score date/direction and counterparties within matching observations. This measures recall of evidence, not precision or proof that every raw row is a valid transaction.",
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key not in ("wrongPriorityCounterpartyAccountObservations", "missingRows")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

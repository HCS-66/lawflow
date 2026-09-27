"""Score verbatim table-cell transcription without normalizing its output."""

import argparse
from collections import Counter
import csv
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path


def number(value):
    value = str(value or "").strip().replace(",", "").replace("−", "-").replace("￥", "")
    try:
        return Decimal(value)
    except InvalidOperation:
        return None


def has_distinct_amount_balance(cells, amount, balance):
    numeric = [(index, number(value)) for index, value in enumerate(cells)]
    return any(index != other and value is not None and other_value is not None
               and abs(value) == amount and other_value == balance
               for index, value in numeric for other, other_value in numeric)


def ratio(found, total):
    return {"found": found, "total": total, "percent": round(100 * found / total, 2) if total else None}


def category(row):
    if row["transactionType"] == "账户转账":
        return "outgoingTransfers" if row["direction"] == "OUT" else "incomingTransfers"
    if row["transactionType"] == "信用卡还款" and row["direction"] == "IN":
        return "creditCardRepaymentSources"
    return ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--gold", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    pages = []
    cells_flat = []
    for path in sorted(args.results.glob("page-*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        result = payload.get("result", {})
        tables = result.get("tables", [])
        page = {"page": payload["page"], "nearTableText": result.get("nearTableText", []),
                "tables": tables, "finishReason": payload.get("finishReason"),
                "parseError": "unparsedContent" in result}
        pages.append(page)
        for table_index, table in enumerate(tables, 1):
            for row_index, row in enumerate(table.get("rows", []), 1):
                for column_index, value in enumerate(row, 1):
                    cells_flat.append({"page": page["page"], "table": table_index,
                                       "row": row_index, "column": column_index, "text": value})
    with (args.out / "cells.csv").open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=("page", "table", "row", "column", "text"))
        writer.writeheader()
        writer.writerows(cells_flat)

    with args.gold.open(newline="", encoding="utf-8-sig") as stream:
        gold = list(csv.DictReader(stream))

    counts = Counter()
    priority = Counter()
    missed = []
    account_missing = []
    counterparty_missing = []
    for expected in gold:
        amount = abs(number(expected["amount"]))
        balance = number(expected["balance"])
        matches = []
        for page in pages:
            nearby_text = " ".join(str(value) for value in page["nearTableText"])
            for table_index, table in enumerate(page["tables"], 1):
                rows = table.get("rows", [])
                for row_index, row in enumerate(rows):
                    if not has_distinct_amount_balance(row, amount, balance):
                        continue
                    row_text = " ".join(str(value) for value in row)
                    next_text = " ".join(str(value) for value in rows[row_index + 1]) if row_index + 1 < len(rows) else ""
                    matches.append({
                        "page": page["page"], "table": table_index, "row": row_index + 1,
                        "owner": expected["accountNumber"] in (row_text + " " + nearby_text),
                        "date": expected["transactionDate"] in row_text,
                        "counterpartySameRow": bool(expected["counterpartyAccount"] and expected["counterpartyAccount"] in row_text),
                        "counterpartySameOrNext": bool(expected["counterpartyAccount"] and expected["counterpartyAccount"] in (row_text + " " + next_text)),
                    })
        counts["amountBalanceSameRow"] += bool(matches)
        owner_matches = [match for match in matches if match["owner"]]
        counts["ownerAmountBalanceSameRow"] += bool(owner_matches)
        counts["ownerAmountBalanceDateSameRow"] += any(match["date"] for match in owner_matches)
        if expected["counterpartyAccount"]:
            counts["counterpartyTotal"] += 1
            counts["counterpartySameRow"] += any(match["counterpartySameRow"] for match in owner_matches)
            counts["counterpartySameOrNext"] += any(match["counterpartySameOrNext"] for match in owner_matches)
            group = category(expected)
            if group:
                priority[group + "Total"] += 1
                priority[group + "SameOrNext"] += any(match["counterpartySameOrNext"] for match in owner_matches)
        if not matches:
            missed.append({key: expected[key] for key in (
                "accountNumber", "transactionDate", "amount", "balance", "counterpartyAccount")})
        elif not owner_matches:
            account_missing.append({key: expected[key] for key in (
                "accountNumber", "transactionDate", "amount", "balance", "counterpartyAccount")})
        elif expected["counterpartyAccount"] and not any(match["counterpartySameOrNext"] for match in owner_matches):
            counterparty_missing.append({key: expected[key] for key in (
                "accountNumber", "transactionDate", "amount", "balance", "counterpartyAccount")})

    report = {
        "scope": "Verbatim cells from upright full-page images; no classification or canonical column mapping in model output",
        "pages": [{"page": p["page"], "tables": len(p["tables"]),
                   "rows": sum(len(t.get("rows", [])) for t in p["tables"]),
                   "finishReason": p["finishReason"], "parseError": p["parseError"]} for p in pages],
        "goldRows": len(gold),
        "amountBalanceSameRawRow": ratio(counts["amountBalanceSameRow"], len(gold)),
        "ownerAmountBalanceSameRawRow": ratio(counts["ownerAmountBalanceSameRow"], len(gold)),
        "ownerAmountBalanceDateSameRawRow": ratio(counts["ownerAmountBalanceDateSameRow"], len(gold)),
        "counterpartySameRawRowAmongNonemptyGold": ratio(counts["counterpartySameRow"], counts["counterpartyTotal"]),
        "counterpartySameOrNextRawRowAmongNonemptyGold": ratio(counts["counterpartySameOrNext"], counts["counterpartyTotal"]),
        "priorityCounterpartiesSameOrNextRawRow": {
            name: ratio(priority[name + "SameOrNext"], priority[name + "Total"])
            for name in ("outgoingTransfers", "incomingTransfers", "creditCardRepaymentSources")
        },
        "missingAmountBalanceRows": missed,
        "missingOwnAccountNearMatchingRow": account_missing,
        "missingCounterpartySameOrNextRow": counterparty_missing,
        "method": "A gold transaction has raw-row evidence when two distinct cells in one OCR row contain its absolute amount and signed balance. Its own account must appear in that row or nearTableText on the page. Counterparty may be in the same or immediately following row because some statement layouts print two lines per transaction. This is an evidence-coverage metric, not a complete transaction-identity or precision score.",
    }
    (args.out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key not in (
        "pages", "missingAmountBalanceRows", "missingOwnAccountNearMatchingRow", "missingCounterpartySameOrNextRow")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

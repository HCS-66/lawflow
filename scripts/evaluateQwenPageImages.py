"""Compare first-pass page-image transcription with the checked 02 statement."""

import argparse
from collections import Counter, defaultdict
import csv
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path


FIELDS = ("page", "rowIndex", "pageOwnerAccount", "accountNumber", "date", "debitCredit",
          "amount", "balance", "counterpartyName", "counterpartyAccount", "description")


def clean(value):
    value = str(value or "").strip()
    return "" if value in ("(空)", "空", "null", "None") else value


def money(value):
    value = clean(value).replace(",", "").replace(" ", "").replace("￥", "")
    try:
        return Decimal(value)
    except InvalidOperation:
        return None


def direction(marker):
    marker = clean(marker)
    if marker.startswith("+") or marker in ("2", "贷"):
        return "IN"
    if marker.startswith("-") or marker in ("1", "借"):
        return "OUT"
    return ""


def recoverable_direction(row):
    explicit = direction(row["debitCredit"])
    return explicit or direction(row["amount"])


def ratio(found, total):
    return {"found": found, "total": total, "percent": round(100 * found / total, 2) if total else None}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--gold", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--scope", default="PDF rendered to full JPEG pages at 250 DPI; no rotation or cropping; one Qwen request per page")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    observations = []
    pages = []
    for path in sorted(args.results.glob("page-*.json")):
        response = json.loads(path.read_text(encoding="utf-8"))
        page = response["page"]
        result = response.get("result", {})
        rows = result.get("rows", [])
        if not isinstance(rows, list):
            rows = []
        pages.append({"page": page, "rows": len(rows), "finishReason": response.get("finishReason"),
                      "parseError": "unparsedContent" in result})
        for index, row in enumerate(rows, 1):
            if not isinstance(row, dict):
                continue
            observations.append({field: clean(row.get(field)) for field in FIELDS} | {
                "page": page, "rowIndex": index, "pageOwnerAccount": clean(result.get("pageOwnerAccount"))
            })
    with (args.out / "raw-rows.csv").open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(observations)

    with args.gold.open(newline="", encoding="utf-8-sig") as stream:
        gold = list(csv.DictReader(stream))
    by_numeric = defaultdict(list)
    by_date_amount = defaultdict(list)
    for row in observations:
        amount, balance = money(row["amount"]), money(row["balance"])
        if amount is not None:
            by_date_amount[(row["date"], abs(amount))].append(row)
        if amount is not None and balance is not None:
            by_numeric[(abs(amount), abs(balance))].append(row)

    def date_amount_key(date, amount, account=""):
        value = money(amount)
        return (date, abs(value), account) if value is not None else None

    date_amount_without_account = Counter(
        date_amount_key(row["date"], row["amount"]) for row in observations
        if date_amount_key(row["date"], row["amount"]) is not None
    )
    date_amount_with_account = Counter(
        date_amount_key(row["date"], row["amount"], row["accountNumber"] or row["pageOwnerAccount"])
        for row in observations
        if date_amount_key(row["date"], row["amount"]) is not None
    )
    gold_date_amount_without_account = Counter(date_amount_key(row["transactionDate"], row["amount"]) for row in gold)
    gold_date_amount_with_account = Counter(date_amount_key(row["transactionDate"], row["amount"], row["accountNumber"]) for row in gold)

    def overlap(expected, observed):
        return sum(min(count, observed[key]) for key, count in expected.items())

    totals = Counter()
    missing = []
    account_disagreement = []
    field_errors = []
    priority = defaultdict(lambda: Counter())
    priority_by_date_amount = defaultdict(lambda: Counter())
    for expected in gold:
        amount, balance = money(expected["amount"]), money(expected["balance"])
        candidates = by_numeric[(abs(amount), abs(balance))]
        totals["numericPresence"] += bool(candidates)
        totals["numericDatePresence"] += any(row["date"] == expected["transactionDate"] for row in candidates)
        account = expected["accountNumber"]
        contextual = [row for row in candidates if account in (row["accountNumber"], row["pageOwnerAccount"])]
        strict = [row for row in contextual if (row["accountNumber"] or row["pageOwnerAccount"]) == account]
        group = ""
        if expected["transactionType"] == "账户转账":
            group = "outgoingTransfers" if expected["direction"] == "OUT" else "incomingTransfers"
        elif expected["transactionType"] == "信用卡还款" and expected["direction"] == "IN":
            group = "creditCardRepaymentSources"
        if group and expected["counterpartyAccount"]:
            priority[group]["total"] += 1
            priority_by_date_amount[group]["total"] += 1
            date_amount_matches = by_date_amount[(expected["transactionDate"], abs(amount))]
            priority_by_date_amount[group]["exactWithoutOwnAccount"] += any(
                row["counterpartyAccount"] == expected["counterpartyAccount"]
                for row in date_amount_matches
            )
            priority_by_date_amount[group]["exactWithOwnAccount"] += any(
                row["counterpartyAccount"] == expected["counterpartyAccount"]
                and expected["accountNumber"] in (row["accountNumber"], row["pageOwnerAccount"])
                for row in date_amount_matches
            )
        if not contextual:
            missing.append({key: expected[key] for key in (
                "accountNumber", "transactionDate", "direction", "amount", "balance",
                "transactionType", "counterpartyAccount")})
            continue
        totals["contextualPresence"] += 1
        totals["strictPresence"] += bool(strict)
        totals["dateExact"] += any(row["date"] == expected["transactionDate"] for row in contextual)
        totals["signedBalanceExact"] += any(money(row["balance"]) == balance for row in contextual)
        totals["directionExact"] += any(direction(row["debitCredit"]) == expected["direction"] for row in contextual)
        totals["directionRecoverable"] += any(recoverable_direction(row) == expected["direction"] for row in contextual)
        if expected["counterpartyAccount"]:
            totals["counterpartyAccountTotal"] += 1
            account_ok = any(row["counterpartyAccount"] == expected["counterpartyAccount"] for row in contextual)
            totals["counterpartyAccountExact"] += account_ok
            if group:
                priority[group]["exact"] += account_ok
        if not strict:
            account_disagreement.append({
                "date": expected["transactionDate"], "amount": expected["amount"],
                "expectedOwnAccount": account,
                "observed": [{"page": row["page"], "rowIndex": row["rowIndex"],
                              "rowAccount": row["accountNumber"], "pageOwnerAccount": row["pageOwnerAccount"]}
                             for row in contextual],
            })
        mismatches = []
        if not any(row["date"] == expected["transactionDate"] for row in contextual):
            mismatches.append("date")
        if not any(money(row["balance"]) == balance for row in contextual):
            mismatches.append("balanceSign")
        if not any(direction(row["debitCredit"]) == expected["direction"] for row in contextual):
            mismatches.append("direction")
        if expected["counterpartyAccount"] and not any(row["counterpartyAccount"] == expected["counterpartyAccount"] for row in contextual):
            mismatches.append("counterpartyAccount")
        if mismatches:
            field_errors.append({"date": expected["transactionDate"], "amount": expected["amount"],
                                 "expectedOwnAccount": account, "mismatches": mismatches,
                                 "observed": [{"page": row["page"], "rowIndex": row["rowIndex"],
                                               "date": row["date"], "balance": row["balance"],
                                               "debitCredit": row["debitCredit"],
                                               "counterpartyAccount": row["counterpartyAccount"]}
                                              for row in contextual]})
    report = {
        "scope": args.scope,
        "pages": pages,
        "rawObservationRows": len(observations),
        "goldRows": len(gold),
        "dateAmountIgnoringOwnAccount": ratio(overlap(gold_date_amount_without_account, date_amount_without_account), len(gold)),
        "dateAmountStrictOwnAccount": ratio(overlap(gold_date_amount_with_account, date_amount_with_account), len(gold)),
        "numericPresenceIgnoringOwnAccount": ratio(totals["numericPresence"], len(gold)),
        "numericDatePresenceIgnoringOwnAccount": ratio(totals["numericDatePresence"], len(gold)),
        "contextualPresence": ratio(totals["contextualPresence"], len(gold)),
        "strictPresence": ratio(totals["strictPresence"], len(gold)),
        "dateExactAmongPresent": ratio(totals["dateExact"], totals["contextualPresence"]),
        "signedBalanceExactAmongPresent": ratio(totals["signedBalanceExact"], totals["contextualPresence"]),
        "directionExactAmongPresent": ratio(totals["directionExact"], totals["contextualPresence"]),
        "directionRecoverableAmongPresent": ratio(totals["directionRecoverable"], totals["contextualPresence"]),
        "counterpartyAccountExactAmongPresentNonempty": ratio(totals["counterpartyAccountExact"], totals["counterpartyAccountTotal"]),
        "priorityCounterpartyAccounts": {name: ratio(counts["exact"], counts["total"]) for name, counts in priority.items()},
        "priorityCounterpartyAccountsByDateAmount": {
            name: {
                "withOwnAccount": ratio(counts["exactWithOwnAccount"], counts["total"]),
                "withoutOwnAccount": ratio(counts["exactWithoutOwnAccount"], counts["total"]),
            } for name, counts in priority_by_date_amount.items()
        },
        "missing": missing,
        "ownAccountDisagreements": account_disagreement,
        "fieldErrors": field_errors,
        "method": "Presence requires exact absolute amount and absolute balance plus own account in either the row or its page header. Strict presence uses the row account if populated, otherwise the page header. Date+amount overlap is counted one-to-one within each repeated key. This is first-pass evidence scoring only; no model merge or repair is fed back to Qwen.",
    }
    (args.out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key not in (
        "missing", "ownAccountDisagreements", "fieldErrors", "pages")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

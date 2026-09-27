"""Trial: literal extraction -> merge/enrich with Gemini -> independent checks.

The input is a cached first-pass CSV. The gold CSV is loaded only after all
candidate output and validation reports have been written.
"""

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
from decimal import Decimal
import json
import os
from pathlib import Path
import time
from urllib.request import Request, urlopen


FIELDS = [
    "accountNumber", "accountName", "bankName", "transactionTime",
    "transactionDate", "direction", "amount", "balance", "transactionType",
    "counterpartyName", "counterpartyAccount", "counterpartyBank",
]
RAW_EVIDENCE_FIELDS = ["rawMerchant", "rawCounterpartyName", "rawDescription", "rawDirectionMarker"]
PATCH_FIELDS = ["bankName", "transactionType", "counterpartyName", "counterpartyAccount", "counterpartyBank"]
TYPES = [
    "账户转账", "存款结息", "手续费", "工资收入", "司法扣划", "保险支出", "贷款放款",
    "贷款还款", "信用卡还款", "消费", "退款", "缴费", "第三方支付", "分期", "分期转换",
    "分期退款", "费用减免", "违约金", "透支利息",
]


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as file:
        return list(csv.DictReader(file))


def write_csv(path, rows):
    with open(path, "w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def write_raw_csv(path, rows):
    fields = FIELDS + RAW_EVIDENCE_FIELDS
    with open(path, "w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def money(value):
    return int(Decimal(value) * 100)


def normalize_directions(raw):
    """Learn numeric debit/credit codes from rows with explicit direction in this extraction."""
    votes = defaultdict(Counter)
    known_by_transaction = defaultdict(set)
    for row in raw:
        if row.get("direction") in ("IN", "OUT"):
            key = tuple(row.get(field, "") for field in ("accountNumber", "transactionDate", "amount", "balance"))
            known_by_transaction[key].add(row["direction"])
    for row in raw:
        marker = row.get("rawDirectionMarker", "").strip()
        direction = row.get("direction", "")
        if marker in ("1", "2") and direction in ("IN", "OUT"):
            votes[marker][direction] += 1
        elif marker in ("1", "2"):
            key = tuple(row.get(field, "") for field in ("accountNumber", "transactionDate", "amount", "balance"))
            matches = known_by_transaction[key]
            if len(matches) == 1:
                votes[marker][next(iter(matches))] += 1
    code_map = {marker: counts.most_common(1)[0][0] for marker, counts in votes.items()
                if len(counts) == 1 or counts.most_common(2)[0][1] > counts.most_common(2)[1][1]}
    filled = 0
    for row in raw:
        if row.get("direction") in ("IN", "OUT"):
            continue
        marker = row.get("rawDirectionMarker", "").strip()
        direction = code_map.get(marker)
        if not direction and marker.startswith("+"):
            direction = "IN"
        if not direction and marker.startswith("-"):
            direction = "OUT"
        if direction:
            row["direction"] = direction
            filled += 1
    return code_map, filled


def merge_rows(raw):
    """Merge matching transactions from overlapping statement views."""
    grouped = defaultdict(list)
    for row in raw:
        key = tuple(row[field] for field in ("accountNumber", "transactionDate", "direction", "balance"))
        grouped[key].append(row)
    merged, conflicts = [], []
    for key, copies in grouped.items():
        chosen = dict(copies[0])
        if len({copy["amount"] for copy in copies}) > 1:
            scores = {}
            for amount in {copy["amount"] for copy in copies}:
                expected_before = money(chosen["balance"]) - (money(amount) if chosen["direction"] == "IN" else -money(amount))
                scores[amount] = any(
                    other["accountNumber"] == chosen["accountNumber"]
                    and other["transactionDate"] <= chosen["transactionDate"]
                    and money(other["balance"]) == expected_before
                    for other in raw if other is not copies[0]
                )
            winners = [amount for amount, valid in scores.items() if valid]
            if len(winners) == 1:
                chosen["amount"] = winners[0]
            else:
                conflicts.append({"key": key, "amounts": [copy["amount"] for copy in copies], "scores": scores})
        for field in FIELDS + RAW_EVIDENCE_FIELDS:
            if field == "amount":
                continue
            options = [copy.get(field, "") for copy in copies if copy.get(field, "")]
            if options:
                chosen[field] = max(options, key=len) if field in ("bankName", "counterpartyBank", "rawMerchant", "rawCounterpartyName", "rawDescription") else options[0]
        merged.append(chosen)
    # Some overlapping views disagree on the balance while agreeing on the
    # transaction identity. Merge only a unique timed/untimed pair whose
    # balance is supported by a neighboring transaction.
    fuzzy_groups = defaultdict(list)
    for row in merged:
        key = tuple(row[field] for field in ("accountNumber", "transactionDate", "direction", "amount", "counterpartyAccount"))
        fuzzy_groups[key].append(row)
    removed = set()
    for copies in fuzzy_groups.values():
        if len(copies) != 2 or copies[0]["balance"] == copies[1]["balance"]:
            continue
        if sum(bool(copy["transactionTime"]) for copy in copies) != 1:
            continue
        scores = []
        for copy in copies:
            signed = money(copy["amount"]) * (1 if copy["direction"] == "IN" else -1)
            before = money(copy["balance"]) - signed
            score = 0
            for other in merged:
                if other in copies or other["accountNumber"] != copy["accountNumber"]:
                    continue
                if other["transactionDate"] <= copy["transactionDate"] and money(other["balance"]) == before:
                    score += 1
                if other["transactionDate"] >= copy["transactionDate"]:
                    other_signed = money(other["amount"]) * (1 if other["direction"] == "IN" else -1)
                    if money(other["balance"]) - other_signed == money(copy["balance"]):
                        score += 1
            scores.append(score)
        if sorted(scores) == [0, max(scores)] and max(scores) > 0:
            winner, loser = copies[scores.index(max(scores))], copies[scores.index(0)]
            for field in FIELDS + RAW_EVIDENCE_FIELDS:
                if not winner.get(field) and loser.get(field):
                    winner[field] = loser[field]
            removed.add(id(loser))
    merged = [row for row in merged if id(row) not in removed]
    return merged, conflicts


def read_key():
    if os.environ.get("GEMINI_API_KEY"):
        return os.environ["GEMINI_API_KEY"]
    path = Path(__file__).resolve().parent.parent / ".dev.vars"
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("GEMINI_API_KEY="):
            return line.split("=", 1)[1].strip().strip("\"'")
    raise RuntimeError("GEMINI_API_KEY is missing")


def enrich_group(account, numbered, known_banks, prompt_template, api_key, model, out, reuse):
    prompt = (prompt_template
              .replace("{{ACCOUNT}}", account)
              .replace("{{KNOWN_BANKS}}", json.dumps(known_banks, ensure_ascii=False))
              .replace("{{ROWS}}", json.dumps({"fields": FIELDS + RAW_EVIDENCE_FIELDS, "rows": numbered}, ensure_ascii=False, separators=(',', ':'))))
    response_path = out / f"response-{account}.json"
    if reuse and response_path.exists():
        data = json.loads(response_path.read_text(encoding="utf-8"))
        started = time.time()
    else:
        payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json", "temperature": 0,
            "thinkingConfig": {"thinkingLevel": "low"}, "maxOutputTokens": 65536,
        },
        }
        request = Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            method="POST",
        )
        started = time.time()
        with urlopen(request, timeout=600) as response:
            data = json.load(response)
        response_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    candidate = data["candidates"][0]
    if candidate.get("finishReason") != "STOP":
        raise RuntimeError(f"{account}: finishReason={candidate.get('finishReason')}")
    content = "".join(part.get("text", "") for part in candidate["content"]["parts"])
    patches = json.loads(content)["patches"]
    expected = {number for number, _ in numbered}
    found = [patch[0] for patch in patches]
    if len(found) != len(expected) or set(found) != expected or len(found) != len(set(found)):
        raise RuntimeError(f"{account}: expected {len(expected)} patches, got {len(found)} with {len(set(found))} distinct ids")
    if any(len(patch) != 6 or any(not isinstance(v, str) for v in patch[1:]) for patch in patches):
        raise RuntimeError(f"{account}: malformed patch")
    return patches, {"account": account, "rows": len(numbered), "seconds": round(time.time() - started, 2), "usage": data.get("usageMetadata")}


def validate(rows, shared_balance_groups=()):
    # Historical experiments may supply source-confirmed account groups from a
    # private local file. Never embed real account numbers in the program.
    group_for_account = {}
    for group_index, accounts in enumerate(shared_balance_groups):
        if not isinstance(accounts, list) or len(accounts) < 2:
            raise ValueError("Each shared balance group must contain at least two account strings")
        for account in accounts:
            if not isinstance(account, str) or not account.strip() or account in group_for_account:
                raise ValueError("Shared balance accounts must be nonempty, unique strings")
            group_for_account[account] = f"shared_credit_balance:{group_index + 1}"
    issues = []
    for i, row in enumerate(rows, 1):
        if row["direction"] not in ("IN", "OUT"):
            issues.append({"row": i, "kind": "invalid_direction"})
        if row["transactionTime"] and not row["transactionTime"].startswith(row["transactionDate"] + " "):
            issues.append({"row": i, "kind": "time_date_conflict"})
        if row["transactionType"] and row["transactionType"] not in TYPES:
            issues.append({"row": i, "kind": "invalid_type", "value": row["transactionType"]})
        if money(row["amount"]) == 0:
            issues.append({"row": i, "kind": "zero_amount_direction_needs_source", "account": row["accountNumber"], "date": row["transactionDate"]})
    groups = defaultdict(list)
    for i, row in enumerate(rows, 1):
        account = row["accountNumber"]
        group = group_for_account.get(account, account)
        groups[group].append((i, row))
    for group, entries in groups.items():
        earliest_date = min(row["transactionDate"] for _, row in entries)
        for i, row in entries:
            if money(row["amount"]) == 0 or row["transactionDate"] == earliest_date:
                continue
            signed = money(row["amount"]) * (1 if row["direction"] == "IN" else -1)
            expected_previous = money(row["balance"]) - signed
            possible = [(j, other) for j, other in entries if j != i and other["transactionDate"] <= row["transactionDate"] and money(other["balance"]) == expected_previous]
            if not possible:
                issues.append({"row": i, "kind": "missing_balance_predecessor", "group": group, "account": row["accountNumber"], "date": row["transactionDate"], "amount": row["amount"], "balance": row["balance"], "expectedPreviousBalance": f"{Decimal(expected_previous) / 100:.2f}"})
    return issues


def compare(candidate, gold):
    signature = lambda row: tuple(row[field] for field in FIELDS)
    gold_counts = Counter(map(signature, gold))
    exact = 0
    for row in candidate:
        sig = signature(row)
        if gold_counts[sig]:
            exact += 1
            gold_counts[sig] -= 1
    core = lambda row: tuple(row[field] for field in ("accountNumber", "transactionDate", "direction", "amount", "balance"))
    gold_core = Counter(map(core, gold))
    core_matches = 0
    for row in candidate:
        sig = core(row)
        if gold_core[sig]:
            core_matches += 1
            gold_core[sig] -= 1
    return {"candidateRows": len(candidate), "goldRows": len(gold), "exactRows12Columns": exact, "coreMatches5Columns": core_matches, "unmatchedGoldCore": sum(gold_core.values())}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", required=True)
    parser.add_argument("--gold", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default=os.environ.get("GEMINI_MODEL", "gemini-3.8-flash"))
    parser.add_argument("--stage2-prompt", default=str(Path(__file__).parent / "prompts/geminiRawToStandardV1.txt"))
    parser.add_argument("--reuse-responses", action="store_true")
    parser.add_argument("--shared-balance-groups", type=Path,
                        help="Private JSON array of source-confirmed account groups; no grouping by default")
    args = parser.parse_args()
    shared_balance_groups = json.loads(args.shared_balance_groups.read_text()) if args.shared_balance_groups else []
    if not isinstance(shared_balance_groups, list):
        raise ValueError("Shared balance configuration must be an array of account groups")
    validate([], shared_balance_groups)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    raw = read_csv(args.raw)
    direction_map, directions_filled = normalize_directions(raw)
    merged, conflicts = merge_rows(raw)
    write_csv(out / "after-merge.csv", merged)
    write_raw_csv(out / "after-merge-evidence.csv", merged)
    (out / "merge-report.json").write_text(json.dumps({"rawRows": len(raw), "directionCodeMap": direction_map, "directionsFilled": directions_filled, "mergedRows": len(merged), "unresolvedConflicts": conflicts}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"First pass {len(raw)} rows; direction filled {directions_filled} via {direction_map}; merged {len(merged)}; unresolved amount conflicts {len(conflicts)}", flush=True)
    api_key = read_key()
    known_banks = sorted({row["bankName"] for row in raw if row["bankName"]})
    prompt_template = Path(args.stage2_prompt).read_text(encoding="utf-8")
    grouped = defaultdict(list)
    for i, row in enumerate(merged):
        grouped[row["accountNumber"]].append((i, [row.get(field, "") for field in FIELDS + RAW_EVIDENCE_FIELDS]))
    patches, runs = [], []
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(enrich_group, account, numbered, known_banks, prompt_template, api_key, args.model, out, args.reuse_responses): account for account, numbered in grouped.items()}
        for future in as_completed(futures):
            account = futures[future]
            result, run = future.result()
            patches.extend(result)
            runs.append(run)
            print(f"Enriched {account}: {run['rows']} rows in {run['seconds']}s", flush=True)
    for patch in patches:
        index = patch[0]
        for field, value in zip(PATCH_FIELDS, patch[1:]):
            if field == "counterpartyAccount" and merged[index][field]:
                continue
            merged[index][field] = value
    write_csv(out / "candidate.csv", merged)
    issues = validate(merged, shared_balance_groups)
    (out / "validation.json").write_text(json.dumps(issues, ensure_ascii=False, indent=2), encoding="utf-8")
    report = {
        "secondPassInput": "first_pass_rows_only",
        "secondPassPdfAttached": False,
        "merge": {"rawRows": len(raw), "directionCodeMap": direction_map, "directionsFilled": directions_filled, "mergedRows": len(merged), "unresolvedConflicts": len(conflicts)},
        "modelRuns": runs,
        "validationIssueCounts": dict(Counter(issue["kind"] for issue in issues)),
    }
    # Gold is strictly evaluation input, never part of the model request or candidate generation.
    report["comparison"] = compare(merged, read_csv(args.gold))
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()

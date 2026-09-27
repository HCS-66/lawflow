"""Run first-pass PDF extraction in independent fixed-size page groups."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
import json
from pathlib import Path
import subprocess
import sys
import time

from pypdf import PdfReader, PdfWriter


HERE = Path(__file__).resolve().parent
SOURCE_PROMPT = HERE / "prompts/geminiPdfRawEvidenceV1.txt"


def split_pdf(source, output, pages_per_group):
    reader = PdfReader(str(source))
    groups = []
    for start in range(0, len(reader.pages), pages_per_group):
        end = min(start + pages_per_group, len(reader.pages))
        label = f"pages-{start + 1:02d}-{end:02d}"
        chunk = output / "pdf-groups" / f"{label}.pdf"
        chunk.parent.mkdir(parents=True, exist_ok=True)
        if not chunk.exists():
            writer = PdfWriter()
            for page in reader.pages[start:end]:
                writer.add_page(page)
            with chunk.open("wb") as file:
                writer.write(file)
        groups.append((label, start + 1, end, chunk))
    return groups


def run_group(group, output, model, attempts):
    label, start, end, pdf = group
    directory = output / label
    report = directory / "report.json"
    csv_path = directory / "raw-evidence.csv"
    if report.exists() and csv_path.exists():
        previous = json.loads(report.read_text(encoding="utf-8"))
        if previous.get("schema") == "legacy16" and previous.get("model") == model and previous.get("prompt") == str(SOURCE_PROMPT):
            return label, start, end, previous["rows"], True
    command = [sys.executable, str(HERE / "experimentGeminiRawEvidence.py"), "--pdf", str(pdf), "--out", str(directory), "--prompt", str(SOURCE_PROMPT), "--model", model, "--schema", "legacy16"]
    for attempt in range(1, attempts + 1):
        result = subprocess.run(command, capture_output=True, text=True, timeout=950)
        if result.returncode == 0:
            result_json = json.loads(result.stdout)
            return label, start, end, result_json["rows"], False
        if attempt == attempts:
            raise RuntimeError(f"{label} failed after {attempts} attempts: {result.stderr[-1000:]}")
        time.sleep(3 * attempt)


def combine(groups, output):
    rows = []
    headers = None
    for label, _, _, _ in groups:
        path = output / label / "raw-evidence.csv"
        with path.open(newline="", encoding="utf-8-sig") as file:
            reader = csv.DictReader(file)
            if headers is None:
                headers = reader.fieldnames
            elif reader.fieldnames != headers:
                raise ValueError(f"Unexpected CSV fields in {path}")
            rows.extend(reader)
    with (output / "raw-evidence.csv").open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--pages-per-group", type=int, required=True)
    parser.add_argument("--model", default="gemini-3.8-flash")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--attempts", type=int, default=3)
    args = parser.parse_args()
    if args.pages_per_group < 1 or args.workers < 1 or args.attempts < 1:
        parser.error("pages-per-group, workers and attempts must be positive")
    output = Path(args.out)
    output.mkdir(parents=True, exist_ok=True)
    groups = split_pdf(Path(args.pdf), output, args.pages_per_group)
    results = []
    errors = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(run_group, group, output, args.model, args.attempts): group[0] for group in groups}
        for future in as_completed(futures):
            try:
                label, start, end, count, reused = future.result()
                results.append({"group": label, "pages": [start, end], "rows": count, "reused": reused})
                print(json.dumps(results[-1], ensure_ascii=False), flush=True)
            except Exception as error:
                errors.append(str(error))
                print(str(error), file=sys.stderr, flush=True)
    if errors:
        raise RuntimeError(f"{len(errors)} page groups failed; rerun to resume successful groups")
    total_rows = combine(groups, output)
    summary = {"pdf": args.pdf, "pagesPerGroup": args.pages_per_group, "groups": sorted(results, key=lambda item: item["pages"][0]), "rawRows": total_rows, "model": args.model, "prompt": str(SOURCE_PROMPT)}
    (output / "group-report.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"pagesPerGroup": args.pages_per_group, "groups": len(groups), "rawRows": total_rows}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

"""First-pass literal PDF transcription with raw evidence columns."""

import argparse
import base64
import csv
import hashlib
import json
import os
from pathlib import Path
import time
from urllib.request import Request, urlopen


RAW_FIELDS = [
    "accountNumber", "accountName", "bankName", "transactionTime", "transactionDate",
    "direction", "amount", "balance", "transactionType", "counterpartyName",
    "counterpartyAccount", "counterpartyBank", "rawMerchant", "rawCounterpartyName",
    "rawDescription", "rawDirectionMarker",
]
RAW_FIELDS_13 = [
    "accountNumber", "accountName", "bankName", "transactionTime", "transactionDate",
    "amount", "balance", "rawDirectionMarker", "rawMerchant", "rawCounterpartyName",
    "counterpartyAccount", "counterpartyBank", "rawDescription",
]
ENFORCEMENT_FIELDS_14 = [
    "accountNumber", "accountName", "bankName", "transactionTime", "transactionDate",
    "direction", "amount", "balance", "counterpartyName", "counterpartyAccount",
    "counterpartyBank", "paymentChannel", "rawDescription", "rawDirectionMarker",
]


def read_key():
    if os.environ.get("GEMINI_API_KEY"):
        return os.environ["GEMINI_API_KEY"]
    path = Path(__file__).resolve().parent.parent / ".dev.vars"
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("GEMINI_API_KEY="):
            return line.split("=", 1)[1].strip().strip("\"'")
    raise RuntimeError("GEMINI_API_KEY is missing")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--prompt", default=str(Path(__file__).parent / "prompts/geminiPdfRawEvidenceV1.txt"))
    parser.add_argument("--mineru-json")
    parser.add_argument("--model", default=os.environ.get("GEMINI_MODEL", "gemini-3.8-flash"))
    parser.add_argument("--schema", choices=("legacy16", "raw13", "enforcement14"), default="legacy16")
    args = parser.parse_args()
    fields = {"legacy16": RAW_FIELDS, "raw13": RAW_FIELDS_13, "enforcement14": ENFORCEMENT_FIELDS_14}[args.schema]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    prompt = Path(args.prompt).read_text(encoding="utf-8")
    mineru_report = None
    if args.mineru_json:
        mineru_bytes = Path(args.mineru_json).read_bytes()
        mineru = json.loads(mineru_bytes)
        pages = mineru.get("pages")
        if not isinstance(pages, list) or any(not isinstance(page.get("text"), str) for page in pages):
            raise ValueError("MinerU JSON must contain pages with text")
        prompt += "\n\nMinerU 逐页文字：" + json.dumps(
            [{"page": page["page"], "text": page["text"]} for page in pages],
            ensure_ascii=False, separators=(",", ":"),
        )
        mineru_report = {"path": args.mineru_json, "sha256": hashlib.sha256(mineru_bytes).hexdigest(), "pages": [page["page"] for page in pages], "textCharacters": sum(len(page["text"]) for page in pages)}
    pdf = base64.b64encode(Path(args.pdf).read_bytes()).decode("ascii")
    payload = {
        "contents": [{"parts": [
            {"text": prompt},
            {"inline_data": {"mime_type": "application/pdf", "data": pdf}},
        ]}],
        "generationConfig": {
            "responseMimeType": "application/json", "temperature": 0,
            "thinkingConfig": {"thinkingLevel": "low"}, "maxOutputTokens": 65536,
        },
    }
    request = Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{args.model}:generateContent",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": read_key()},
        method="POST",
    )
    started = time.time()
    with urlopen(request, timeout=900) as response:
        result = json.load(response)
    (out / "gemini-response.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    candidate = result["candidates"][0]
    finish_reason = candidate.get("finishReason")
    raw_text = "".join(part.get("text", "") for part in candidate.get("content", {}).get("parts", []))
    (out / "gemini-output.txt").write_text(raw_text, encoding="utf-8")
    if finish_reason != "STOP":
        raise RuntimeError(f"Gemini stopped with {finish_reason}")
    rows = json.loads(raw_text)["rows"]
    for i, row in enumerate(rows, 1):
        if not isinstance(row, list) or len(row) != len(fields) or any(not isinstance(value, str) for value in row):
            raise ValueError(f"Row {i} is not {len(fields)} strings")
    with (out / "raw-evidence.csv").open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.writer(file)
        writer.writerow(fields)
        writer.writerows(rows)
    report = {
        "pdf": args.pdf, "model": args.model, "prompt": args.prompt, "schema": args.schema,
        "rows": len(rows), "seconds": round(time.time() - started, 2),
        "mineru": mineru_report,
        "usage": result.get("usageMetadata"),
    }
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()

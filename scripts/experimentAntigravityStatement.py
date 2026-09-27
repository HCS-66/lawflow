"""Try the managed Antigravity agent on pages rendered from a PDF."""

import argparse
import base64
import csv
import hashlib
import json
import os
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


FIELDS = (
    "accountNumber", "accountName", "bankName", "transactionTime",
    "transactionDate", "direction", "amount", "balance", "transactionType",
    "counterpartyName", "counterpartyAccount", "counterpartyBank",
)
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions"


def read_key():
    key = os.environ.get("GEMINI_API_KEY")
    if key:
        return key
    vars_path = Path(__file__).resolve().parent.parent / ".dev.vars"
    for line in vars_path.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("GEMINI_API_KEY="):
            return line.split("=", 1)[1].strip().strip("\"'")
    raise RuntimeError("GEMINI_API_KEY is missing")


def call(method, url, key, payload=None):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request = Request(
        url, data=data, method=method,
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": key,
            "Api-Revision": "2026-05-20",
        },
    )
    try:
        with urlopen(request, timeout=120) as response:
            return json.load(response)
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Antigravity HTTP {error.code}: {body[:1200]}") from error


def output_text(interaction):
    if isinstance(interaction.get("output_text"), str):
        return interaction["output_text"]
    for step in reversed(interaction.get("steps", [])):
        if step.get("type") == "model_output":
            content = step.get("content", [])
            if isinstance(content, str):
                return content
            return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--pages-dir", required=True)
    parser.add_argument("--expected-pages", type=int)
    parser.add_argument("--prompt", default=str(Path(__file__).parent / "prompts/geminiPdfToCsv.txt"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--max-total-tokens", type=int, default=250000)
    parser.add_argument("--poll-seconds", type=int, default=15)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    key = read_key()
    pages = sorted(Path(args.pages_dir).glob("source-*.jpg"))
    if not pages or (args.expected_pages is not None and len(pages) != args.expected_pages):
        raise ValueError(f"Expected {args.expected_pages or 'some'} rendered source-*.jpg pages, got {len(pages)}")

    if args.resume:
        interaction_id = (out / "interaction-id.txt").read_text(encoding="utf-8").strip()
        interaction = call("GET", f"{ENDPOINT}/{interaction_id}", key)
    else:
        prompt = Path(args.prompt).read_text(encoding="utf-8")
        prompt = prompt.replace("随请求附上的银行流水 PDF", "随请求按页码附上的银行流水 PDF 页面图像", 1)
        prompt += f"\n\n以下图像按原 PDF 页序排列，共 {len(pages)} 页。你可以使用 Agent 的工具逐项核对，但最终只返回完整 JSON，不要省略交易行。"
        pdf_bytes = Path(args.pdf).read_bytes()
        inputs = [{"type": "text", "text": prompt}]
        for index, page in enumerate(pages, 1):
            inputs.append({"type": "text", "text": f"原 PDF 第 {index} 页"})
            inputs.append({
                "type": "image", "data": base64.b64encode(page.read_bytes()).decode("ascii"),
                "mime_type": "image/jpeg",
            })
        payload = {
            "agent": "antigravity-preview-09-2026",
            "input": inputs,
            "environment": "remote",
            "background": True,
            "agent_config": {
                "type": "antigravity", "model": "gemini-3.8-flash",
                "max_total_tokens": args.max_total_tokens,
            },
        }
        (out / "input-summary.json").write_text(json.dumps({
            "pdf": args.pdf, "pdfSha256": hashlib.sha256(pdf_bytes).hexdigest(),
            "renderedPages": len(pages), "renderedPageBytes": sum(page.stat().st_size for page in pages),
            "pagesDir": args.pages_dir,
            "prompt": args.prompt, "agent": payload["agent"],
            "maxTotalTokens": args.max_total_tokens,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        interaction = call("POST", ENDPOINT, key, payload)
        interaction_id = interaction["id"]
        (out / "interaction-id.txt").write_text(interaction_id, encoding="utf-8")
    (out / "response.json").write_text(json.dumps(interaction, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"id": interaction_id, "status": interaction.get("status")}, ensure_ascii=False), flush=True)

    started = time.time()
    while interaction.get("status") in ("in_progress", "queued"):
        time.sleep(args.poll_seconds)
        interaction = call("GET", f"{ENDPOINT}/{interaction_id}", key)
        (out / "response.json").write_text(json.dumps(interaction, ensure_ascii=False, indent=2), encoding="utf-8")
        if int(time.time() - started) % 60 < args.poll_seconds:
            print(json.dumps({"status": interaction.get("status"), "seconds": round(time.time() - started)}, ensure_ascii=False), flush=True)

    response_text = output_text(interaction)
    (out / "agent-output.txt").write_text(response_text, encoding="utf-8")
    print(json.dumps({"status": interaction.get("status"), "seconds": round(time.time() - started, 2), "usage": interaction.get("usage"), "outputCharacters": len(response_text)}, ensure_ascii=False), flush=True)
    if not response_text.strip():
        return
    cleaned = response_text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    rows = json.loads(cleaned)["rows"]
    for index, row in enumerate(rows, 1):
        if not isinstance(row, list) or len(row) != len(FIELDS) or any(not isinstance(value, str) for value in row):
            raise ValueError(f"Row {index} is not 12 strings")
    with (out / "candidate.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(FIELDS)
        writer.writerows(rows)
    print(json.dumps({"candidateRows": len(rows)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

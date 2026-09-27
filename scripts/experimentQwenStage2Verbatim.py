"""One Qwen text-only request over one list of all saved stage-1 page results."""

import argparse
import csv
import http.client
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


COLUMNS = [
    "accountNumber", "accountName", "bankName", "transactionTime",
    "transactionDate", "direction", "amount", "balance",
    "transactionType", "counterpartyName", "counterpartyAccount", "counterpartyBank",
]


def first_stage_list(input_dir):
    pages = []
    for path in sorted(input_dir.glob("page-*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("finishReason") != "stop" or not isinstance(data.get("result"), dict):
            raise ValueError(f"Incomplete first-stage result: {path.name}")
        pages.append({"page": data["page"], **data["result"]})
    if [page["page"] for page in pages] != list(range(1, 28)):
        raise ValueError("Expected the full 27-page first-stage list")
    return pages


def request_all(key, model, base_url, prompt, pages, max_tokens, partial_path):
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt + "\n第一阶段结果列表：\n" +
                      json.dumps(pages, ensure_ascii=False, separators=(",", ":"))}],
        "response_format": {"type": "json_object"},
        "reasoning_effort": "low",
        "temperature": 0,
        "max_tokens": max_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    request = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        method="POST",
    )
    chunks = []
    finish_reason = None
    usage = None
    returned_model = None
    with urllib.request.urlopen(request, timeout=1200) as response:
        with partial_path.open("w", encoding="utf-8") as partial_file:
            for line in response:
                if not line.startswith(b"data:"):
                    continue
                data = line[5:].strip()
                if data == b"[DONE]":
                    break
                event = json.loads(data)
                returned_model = event.get("model", returned_model)
                usage = event.get("usage") or usage
                choice = (event.get("choices") or [{}])[0]
                finish_reason = choice.get("finish_reason") or finish_reason
                content = choice.get("delta", {}).get("content", "") or ""
                if content:
                    chunks.append(content)
                    partial_file.write(content)
                    partial_file.flush()
                    if len(chunks) % 100 == 0:
                        print(f"received {sum(map(len, chunks))} characters", flush=True)
    return {"model": returned_model, "finishReason": finish_reason,
            "usage": usage, "rawContent": "".join(chunks)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--prompt-file", type=Path, default=Path("scripts/prompts/qwenStage2FromVerbatimV1.txt"))
    parser.add_argument("--model", default="qwen3.8-flash")
    parser.add_argument("--base-url", default="https://dashscope.aliyuncs.com/compatible-mode/v1")
    parser.add_argument("--max-tokens", type=int, default=65536)
    args = parser.parse_args()
    key = sys.stdin.readline().strip().replace("\\_", "_")
    if not key:
        raise SystemExit("Missing API key on stdin")
    pages = first_stage_list(args.input_dir)
    prompt = args.prompt_file.read_text(encoding="utf-8")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    print(f"Sending one list of {len(pages)} first-stage pages in one request", flush=True)
    try:
        output = request_all(key, args.model, args.base_url, prompt, pages, args.max_tokens,
                             args.output_dir / "all-stream.partial.txt")
    except urllib.error.HTTPError as error:
        detail = error.read(1000).decode("utf-8", "replace")
        raise SystemExit(f"HTTP {error.code}: {detail}") from error
    except (http.client.RemoteDisconnected, TimeoutError) as error:
        raise SystemExit(f"Stream disconnected: {error}") from error
    content = output["rawContent"]
    raw_path = args.output_dir / "all-response.json"
    raw_path.write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")
    try:
        result = json.loads(content)
        rows = result["rows"]
        if not isinstance(rows, list) or any(not isinstance(row, list) or len(row) != 12 or
                                              not all(isinstance(value, str) for value in row) for row in rows):
            raise ValueError("Rows must contain exactly 12 string columns")
    except (ValueError, KeyError, TypeError) as error:
        print(f"Response saved but cannot assemble CSV: {error}; finish={output['finishReason']}", flush=True)
        return
    with (args.output_dir / "standard.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(COLUMNS)
        writer.writerows(rows)
    print(f"Assembled {len(rows)} rows; finish={output['finishReason']}", flush=True)


if __name__ == "__main__":
    main()

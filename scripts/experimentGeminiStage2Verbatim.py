"""One Gemini text-only stage-2 request over all saved stage-1 page results."""

import argparse
import csv
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

from experimentQwenStage2Verbatim import COLUMNS, first_stage_list
from experimentThreePassStatement import read_key


def request_all(key, model, prompt, pages, output_dir):
    payload = {
        "contents": [{"parts": [{"text": prompt + "\n" + json.dumps(
            pages, ensure_ascii=False, separators=(",", ":"))}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0,
            "thinkingConfig": {"thinkingLevel": "low"},
            "maxOutputTokens": 65536,
        },
    }
    request = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    chunks = []
    usage = None
    finish_reason = None
    events = 0
    started = time.time()
    with urllib.request.urlopen(request, timeout=1200) as response:
        with (output_dir / "all-stream.partial.txt").open("w", encoding="utf-8") as partial:
            for line in response:
                if not line.startswith(b"data: "):
                    continue
                event = json.loads(line[6:])
                events += 1
                usage = event.get("usageMetadata") or usage
                for candidate in event.get("candidates", []):
                    finish_reason = candidate.get("finishReason") or finish_reason
                    content = "".join(part.get("text", "") for part in candidate.get("content", {}).get("parts", []))
                    if content:
                        chunks.append(content)
                        partial.write(content)
                        partial.flush()
                if events % 100 == 0:
                    print(f"received {sum(map(len, chunks))} characters", flush=True)
    return {"model": model, "finishReason": finish_reason, "usage": usage,
            "seconds": round(time.time() - started, 2), "events": events,
            "rawContent": "".join(chunks)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--prompt-file", type=Path, default=Path("scripts/prompts/geminiVerbatimToStandardV1.txt"))
    parser.add_argument("--model", default="gemini-3.8-flash")
    args = parser.parse_args()
    pages = first_stage_list(args.input_dir)
    prompt = args.prompt_file.read_text(encoding="utf-8")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    print(f"Sending one list of {len(pages)} first-stage pages to Gemini", flush=True)
    try:
        output = request_all(read_key(), args.model, prompt, pages, args.output_dir)
    except urllib.error.HTTPError as error:
        detail = error.read(1000).decode("utf-8", "replace")
        raise SystemExit(f"HTTP {error.code}: {detail}") from error
    (args.output_dir / "all-response.json").write_text(
        json.dumps(output, ensure_ascii=False), encoding="utf-8")
    try:
        rows = json.loads(output["rawContent"])["rows"]
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
    print(f"Assembled {len(rows)} rows; finish={output['finishReason']}; seconds={output['seconds']}", flush=True)


if __name__ == "__main__":
    main()

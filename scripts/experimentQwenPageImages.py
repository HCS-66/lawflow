"""Send full PDF page images to Qwen, one request per page.

The API key is read from stdin and is never written to disk. Image preparation
(including any rotation) is handled separately and recorded with each run.
"""

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from tryQwenHardPages import PROMPT


def request_page(image_path, key, model, base_url, prompt):
    image_data = base64.b64encode(image_path.read_bytes()).decode("ascii")
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + image_data}},
        ]}],
        "response_format": {"type": "json_object"},
        "reasoning_effort": "low",
        "vl_high_resolution_images": True,
        "temperature": 0,
        "max_tokens": 16000,
    }
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--pages", type=int, default=27)
    parser.add_argument("--selected-pages", help="Comma-separated page numbers for a pilot run")
    parser.add_argument("--image-prefix", default="raw")
    parser.add_argument("--prompt-file", type=Path)
    parser.add_argument("--model", default="qwen3.8-flash")
    parser.add_argument("--base-url", default="https://dashscope.aliyuncs.com/compatible-mode/v1")
    args = parser.parse_args()
    key = sys.stdin.readline().strip().replace("\\_", "_")
    if not key:
        raise SystemExit("Missing API key on stdin")
    prompt = args.prompt_file.read_text(encoding="utf-8") if args.prompt_file else PROMPT
    args.output_dir.mkdir(parents=True, exist_ok=True)
    selected_pages = ([int(item) for item in args.selected_pages.split(",")]
                      if args.selected_pages else range(1, args.pages + 1))
    for page in selected_pages:
        image_path = args.input_dir / f"{args.image_prefix}-{page:02d}.jpg"
        output_path = args.output_dir / f"page-{page:02d}.json"
        if output_path.exists():
            print(f"page {page}: existing result", flush=True)
            continue
        if not image_path.exists():
            print(f"page {page}: missing image {image_path}", file=sys.stderr, flush=True)
            continue
        for attempt in range(1, 4):
            try:
                response = request_page(image_path, key, args.model, args.base_url, prompt)
                choice = response.get("choices", [{}])[0]
                content = choice.get("message", {}).get("content", "")
                try:
                    result = json.loads(content)
                except (TypeError, json.JSONDecodeError):
                    result = {"unparsedContent": content}
                output_path.write_text(json.dumps({
                    "page": page,
                    "model": response.get("model"),
                    "finishReason": choice.get("finish_reason"),
                    "usage": response.get("usage"),
                    "result": result,
                }, ensure_ascii=False, indent=2), encoding="utf-8")
                row_count = len(result.get("rows", [])) + sum(
                    len(table.get("rows", [])) for table in result.get("tables", [])
                    if isinstance(table, dict)
                )
                print(f"page {page}: {row_count} rows, finish={choice.get('finish_reason')}", flush=True)
                break
            except urllib.error.HTTPError as error:
                detail = error.read(500).decode("utf-8", "replace")
                print(f"page {page}: HTTP {error.code} attempt {attempt}: {detail}", file=sys.stderr, flush=True)
                if error.code not in (429, 500, 502, 503, 504):
                    break
            except Exception as error:
                print(f"page {page}: {type(error).__name__} attempt {attempt}: {error}", file=sys.stderr, flush=True)
            time.sleep(min(2 ** attempt, 8))


if __name__ == "__main__":
    main()

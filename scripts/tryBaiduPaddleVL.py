"""Try Baidu's hosted PaddleOCR-VL document parser on page images.

Read API Key and Secret Key from separate stdin lines. Credentials and the
temporary access token are never saved.
"""

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


API_ROOT = "https://aip.baidubce.com"
TASK_PATH = "/rest/2.0/brain/online/v2/paddle-vl-parser/task"
OUT_DIR = Path("tmp/ocr-hard-pages")


def post_form(url, fields, timeout=120):
    body = urllib.parse.urlencode(fields).encode("ascii")
    request = urllib.request.Request(
        url, body, {"Content-Type": "application/x-www-form-urlencoded"}, method="POST"
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def download(url, path):
    with urllib.request.urlopen(url, timeout=120) as response:
        path.write_bytes(response.read())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pages", nargs="*", type=int)
    parser.add_argument("--pdf-file", type=Path)
    parser.add_argument("--max-wait-seconds", type=int, default=360)
    args = parser.parse_args()
    if bool(args.pages) == bool(args.pdf_file):
        parser.error("provide page numbers or --pdf-file")

    api_key = sys.stdin.readline().strip()
    secret_key = sys.stdin.readline().strip()
    if not api_key or not secret_key:
        raise SystemExit("API Key and Secret Key required on stdin")

    token_response = post_form(
        API_ROOT + "/oauth/2.0/token",
        {"grant_type": "client_credentials", "client_id": api_key, "client_secret": secret_key},
        timeout=60,
    )
    token = token_response.get("access_token")
    if not token:
        print("Authentication failed:", token_response.get("error"))
        raise SystemExit(1)
    token_query = "?access_token=" + urllib.parse.quote(token)
    submit_url = API_ROOT + TASK_PATH + token_query
    query_url = API_ROOT + TASK_PATH + "/query" + token_query
    if args.pdf_file:
        sources = [(args.pdf_file.stem, args.pdf_file)]
    else:
        sources = [(f"page-{page}", OUT_DIR / f"page-{page}-upright.jpg") for page in args.pages]
    task_ids = {}
    for label, source_path in sources:
        file_data = base64.b64encode(source_path.read_bytes()).decode("ascii")
        try:
            result = post_form(submit_url, {"file_data": file_data, "file_name": source_path.name})
        except urllib.error.HTTPError as exc:
            print(f"{label}: submit HTTP {exc.code}", flush=True)
            continue
        if result.get("error_code") != 0:
            print(f"{label}: submit error {result.get('error_code')}: {result.get('error_msg')}", flush=True)
            continue
        task_id = result.get("result", {}).get("task_id")
        if not task_id:
            print(f"{label}: no task id in response", flush=True)
            continue
        task_ids[label] = task_id
        print(f"{label}: submitted", flush=True)
        time.sleep(0.6)

    (OUT_DIR / "baidu-paddle-vl-task-ids.json").write_text(json.dumps(task_ids, indent=2))
    statuses = {}
    started = time.monotonic()
    while task_ids and time.monotonic() - started < args.max_wait_seconds:
        for label, task_id in list(task_ids.items()):
            try:
                response = post_form(query_url, {"task_id": task_id}, timeout=60)
            except urllib.error.HTTPError as exc:
                print(f"{label}: query HTTP {exc.code}", flush=True)
                continue
            if response.get("error_code") != 0:
                print(f"{label}: query error {response.get('error_code')}: {response.get('error_msg')}", flush=True)
                del task_ids[label]
                continue
            result = response.get("result", {})
            status = result.get("status")
            if statuses.get(label) != status:
                print(f"{label}: {status}", flush=True)
                statuses[label] = status
            if status == "failed":
                print(f"{label}: {result.get('task_error')}", flush=True)
                del task_ids[label]
            elif status == "success":
                try:
                    download(result["parse_result_url"], OUT_DIR / f"{label}-baidu-paddle-vl.json")
                    if result.get("markdown_url"):
                        download(result["markdown_url"], OUT_DIR / f"{label}-baidu-paddle-vl.md")
                    print(f"{label}: output saved", flush=True)
                except (KeyError, urllib.error.URLError, TimeoutError) as exc:
                    print(f"{label}: download failed: {type(exc).__name__}", flush=True)
                del task_ids[label]
        if task_ids:
            time.sleep(8)
    if task_ids:
        print("Pending pages:", sorted(task_ids), flush=True)


if __name__ == "__main__":
    main()

"""Call Baidu Cloud OCR on selected statement page images.

Reads API Key and Secret Key from two stdin lines. Credentials and the
temporary access token are kept in memory and never included in saved output.
"""

import argparse
import base64
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


API_ROOT = "https://aip.baidubce.com"
MODES = {"table": "/rest/2.0/ocr/v1/table", "accurate": "/rest/2.0/ocr/v1/accurate"}


def post_form(url: str, fields: dict, timeout: int = 300) -> dict:
    body = urllib.parse.urlencode(fields).encode("ascii")
    request = urllib.request.Request(
        url,
        body,
        {"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pages", type=int, nargs="+")
    parser.add_argument("--mode", choices=MODES, default="table")
    args = parser.parse_args()

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
        print("Authentication failed:", token_response.get("error"), token_response.get("error_description"))
        raise SystemExit(1)
    print("Authenticated with Baidu OCR", flush=True)

    out_dir = Path("tmp/ocr-hard-pages")
    for page in args.pages:
        image_path = out_dir / f"page-{page}-upright.jpg"
        image = base64.b64encode(image_path.read_bytes()).decode("ascii")
        params = {"image": image}
        if args.mode == "table":
            params["return_excel"] = "false"
            params["cell_contents"] = "false"
        url = API_ROOT + MODES[args.mode] + "?access_token=" + urllib.parse.quote(token)
        print(f"page {page}: requesting Baidu {args.mode}", flush=True)
        try:
            result = post_form(url, params)
        except urllib.error.HTTPError as exc:
            print(f"page {page}: HTTP {exc.code}", file=sys.stderr, flush=True)
            continue
        except Exception as exc:
            print(f"page {page}: request failed: {type(exc).__name__}", file=sys.stderr, flush=True)
            continue
        path = out_dir / f"page-{page}-baidu-{args.mode}.json"
        path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        if "error_code" in result:
            print(f"page {page}: error {result['error_code']}: {result.get('error_msg')}", flush=True)
        else:
            count = result.get("table_num", result.get("words_result_num", "?"))
            print(f"page {page}: result count {count} -> {path}", flush=True)


if __name__ == "__main__":
    main()

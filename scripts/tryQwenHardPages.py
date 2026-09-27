"""Transcribe selected bank-statement page images with Qwen3.8-Flash.

The API key is read once from stdin and never written to disk.
"""

import argparse
import base64
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


PROMPT = """请逐行抄录这张银行流水图片。只抄图片中清楚可见的内容，不依据相邻行补全，不推断被截断的字段。
如果页眉同时有姓名、18位身份证号码和16位银行卡号，pageOwnerAccount 必须填16位银行卡号，不要填身份证号码。行内若只印出卡号前8位，accountNumber 只抄前8位。
返回 JSON 对象：{"pageOwnerAccount":"页眉完整卡号或空字符串","rows":[{"accountNumber":"行内卡号","date":"交易日期","debitCredit":"借贷栏原文","amount":"交易金额","balance":"更新后余额","counterpartyName":"对方账户栏原文","counterpartyAccount":"对方卡号/账号栏原文","description":"交易描述栏原文"}]}。
每条可见交易一项，按图片从上到下顺序。空白单元格用空字符串。数字、负号、小数点和账号逐字照抄；不要合并交易。只输出 JSON。"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pages", nargs="+", type=int)
    parser.add_argument("--base-url", default="https://dashscope.aliyuncs.com/compatible-mode/v1")
    parser.add_argument("--model", default="qwen3.8-flash")
    args = parser.parse_args()
    key = sys.stdin.readline().strip().replace("\\_", "_")
    if not key:
        raise SystemExit("Missing API key on stdin")
    out_dir = Path("tmp/ocr-hard-pages")
    for page in args.pages:
        image_path = out_dir / f"page-{page}-upright.jpg"
        image_data = base64.b64encode(image_path.read_bytes()).decode("ascii")
        request_data = {
            "model": args.model,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + image_data}},
            ]}],
            "response_format": {"type": "json_object"},
            "reasoning_effort": "low",
            "vl_high_resolution_images": True,
            "temperature": 0,
            "max_tokens": 16000,
        }
        req = urllib.request.Request(
            args.base_url.rstrip("/") + "/chat/completions",
            data=json.dumps(request_data, ensure_ascii=False).encode("utf-8"),
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
            method="POST",
        )
        print(f"page {page}: requesting {args.model}", flush=True)
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                response = json.load(resp)
        except urllib.error.HTTPError as exc:
            body = exc.read(4000).decode("utf-8", "replace")
            print(f"page {page}: HTTP {exc.code}: {body}", file=sys.stderr, flush=True)
            continue
        except Exception as exc:
            print(f"page {page}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            continue
        message = response.get("choices", [{}])[0].get("message", {})
        content = message.get("content", "")
        result_path = out_dir / f"page-{page}-qwen.json"
        try:
            parsed = json.loads(content)
        except (TypeError, json.JSONDecodeError):
            parsed = {"unparsedContent": content}
        result_path.write_text(json.dumps({
            "model": response.get("model"),
            "finishReason": response.get("choices", [{}])[0].get("finish_reason"),
            "usage": response.get("usage"),
            "result": parsed,
        }, ensure_ascii=False, indent=2))
        print(f"page {page}: {len(parsed.get('rows', []))} rows -> {result_path}", flush=True)


if __name__ == "__main__":
    main()

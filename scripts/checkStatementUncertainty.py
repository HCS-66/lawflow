"""Gold-blind review signals and a local review page for the uncertainty trial."""

import argparse
from collections import Counter
from datetime import date
from decimal import Decimal, InvalidOperation
from html import escape
import json
from pathlib import Path
import re

from experimentQwenStage2Verbatim import COLUMNS

CRITICAL = {0, 5, 6, 7, 10}
LABELS = ['本方账号', '本方姓名', '本方银行', '时间', '日期', '方向', '金额', '余额', '类型', '对方名称', '对方账号', '对方银行']


def canonical(field, text):
    text = text.strip().replace('−', '-').replace('，', ',')
    if field in (6, 7):
        cleaned = text.replace(',', '').replace('￥', '').replace('¥', '')
        try:
            value = Decimal(cleaned)
            if not value.is_finite():
                return None
            return str(abs(value) if field == 6 else value)
        except InvalidOperation:
            return None
    if field in (0, 10):
        numbers = re.findall(r'(?<!\d)\d{8,}(?!\d)', text)
        return numbers[0] if len(numbers) == 1 else None
    if field == 4:
        match = re.search(r'(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?!\d)', text)
        if match:
            y, m, d = map(int, match.groups())
            return f'{y:04}-{m:02}-{d:02}'
        return None
    if field == 5:
        if text in ('IN', '收入', '贷', '借贷2', '2'):
            return 'IN'
        if text in ('OUT', '支出', '借', '借贷1', '1'):
            return 'OUT'
        if re.fullmatch(r'[+-][\d,.]+', text):
            return 'OUT' if text.startswith('-') else 'IN'
    return None


def comparable(field, value):
    if value is None:
        return None
    return Decimal(value) if field in (6, 7) else value


def source_value(field, text, output):
    # A header may contain an ID number and an account. Exact bounded occurrence
    # supports copying the account; do not mistake the unrelated ID for a conflict.
    if field in (0, 10) and output:
        candidates = re.findall(r'(?<!\d)\d{8,}(?!\d)', text)
        if output in candidates:
            return output
    return canonical(field, text)


def build_review(rows, registry, pages):
    cells, source_rows = registry['cells'], registry['rows']
    page_schema = {p['page']: p.get('schemaIssues', []) for p in pages}
    result = []
    used_rows = set()
    for number, item in enumerate(rows, 1):
        issues = []

        def add(stage, field, kind, reason, refs=()):
            flag = {'stage': stage, 'field': field, 'kind': kind, 'reason': reason,
                    'refs': list(refs), 'priority': 'critical' if field in CRITICAL else 'ordinary'}
            if flag not in issues:
                issues.append(flag)

        for issue in item['issues']:
            add('stage2', issue['field'], issue['kind'], issue['reason'], issue.get('refs', []))
        for f in (0, 5, 6, 7):
            if not item['values'][f]:
                add('program', f, 'missing_value', '本方账号、方向、金额或余额等关键字段为空')
        for f in (6, 7):
            value = item['values'][f]
            if value and not re.fullmatch(r'-?\d+\.\d{2}', value):
                add('program', f, 'invalid_money', '金额或余额不是明确的两位小数')
        if item['values'][6].startswith('-'):
            add('program', 6, 'invalid_amount_sign', '标准金额应为绝对值，方向单独记录')
        if item['values'][5] and item['values'][5] not in ('IN', 'OUT'):
            add('program', 5, 'invalid_direction', '方向不是 IN 或 OUT')
        if item['values'][4]:
            try:
                date.fromisoformat(item['values'][4])
            except ValueError:
                add('program', 4, 'invalid_date', '日期不是有效的完整年月日')
        if item['confidence'] != 'high' and not item['issues']:
            add('stage2', -1, 'uncertain', '第二阶段自报不确定，但未给出具体字段')
        if not item['sourceRows']:
            add('program', -1, 'missing_source', '没有交易来源行')
        for ref in item['sourceRows']:
            row = source_rows.get(ref)
            if row is None:
                add('program', -1, 'invalid_source', '交易来源行不存在', [ref])
                continue
            used_rows.add(ref)
            for message in page_schema.get(row.get('page'), []):
                add('program', -1, 'page_schema', f'第{row["page"]}页：{message}')
            # Retain upstream uncertainty even if stage 2 neglects its field reference.
            if row['confidence'] != 'high' and not row['issues']:
                if row['confidence'] == 'unknown':
                    add('program', -1, 'confidence_schema', '第一阶段置信度数量与行数不符，无法确定本行评分', [ref])
                else:
                    add('stage1', -1, 'uncertain', '原始行被标为不确定，未给出具体单元格', [ref])
            for issue in row['issues']:
                cell_ref = row['cellRefs'][issue['column'] - 1]
                fields = [f for f, refs in enumerate(item['refs']) if cell_ref in refs]
                for field in fields or [-1]:
                    add('stage1', field, issue['status'], issue['reason'], [cell_ref])
        for f, refs in enumerate(item['refs']):
            source_required = CRITICAL if item.get('referenceScope') == 'critical_fields_and_reported_issues' else CRITICAL | {4}
            if item['values'][f] and not refs and f in source_required:
                add('program', f, 'missing_source', '非空字段没有来源单元格')
            candidates = []
            for ref in refs:
                cell = cells.get(ref)
                if cell is None:
                    add('program', f, 'invalid_source', '字段来源单元格不存在', [ref])
                    continue
                if 'row' in cell and cell['row'] not in item['sourceRows']:
                    add('program', f, 'outside_sources', '字段引用的原始行未列入本笔来源，需检查对应关系', [ref])
                for issue in cell['issues']:
                    add('stage1', f, issue['status'], issue['reason'], [ref])
                normalized = source_value(f, cell['text'], item['values'][f])
                if normalized is not None:
                    candidates.append((ref, comparable(f, normalized)))
            values = {value for _, value in candidates}
            if len(values) > 1:
                add('program', f, 'source_conflict', '同笔字段的来源给出不同候选值', [ref for ref, _ in candidates])
            if f in source_required and item['values'][f] and refs:
                actual = comparable(f, canonical(f, item['values'][f]))
                selected = cells.get(refs[0])
                expected = comparable(f, source_value(f, selected['text'], item['values'][f])) if selected else None
                if actual is not None and expected is not None and actual != expected:
                    add('program', f, 'source_mismatch', '输出值与声明选用的第一个来源不符', [refs[0]])
                elif actual is not None and not candidates:
                    add('program', f, 'unverified_source', '现有规则无法从引用原格核实该值', refs)
        result.append({'outputRow': number, 'values': item['values'], 'confidence': item['confidence'],
                       'sourceRows': item['sourceRows'], 'issues': issues,
                       'needsReview': bool(issues),
                       'priorityReview': any(i['priority'] == 'critical' for i in issues)})
    # Page flags are reported separately; they cannot identify a silently omitted transaction.
    page_flags = [{'page': p['page'], **p['pageReview']} for p in pages
                  if p['pageReview']['coverage'] != 'complete' or p['pageReview']['tablePresence'] == 'uncertain']
    page_flags.extend({'page': p['page'], 'source': 'program', 'reasons': p['schemaIssues']}
                      for p in pages if p.get('schemaIssues'))
    source_use = Counter(ref for r in rows for ref in set(r['sourceRows']) if ref in source_rows)
    multiply_used = {ref: n for ref, n in source_use.items() if n > 1}
    # Unassigned rows include headers/totals. Do not call all of them missing transactions.
    return {'rows': result, 'pageFlags': page_flags,
            'sourceRowsUsed': len(used_rows), 'sourceRowsAvailable': len(source_rows),
            'multiplyUsedSourceRows': multiply_used,
            'unassignedSourceRows': sorted(set(source_rows) - used_rows),
            'limitations': ['No independent original-image coverage proof.',
                            'Conflict checks depend on model-provided merge relationships and references.',
                            'No balance continuity rule is enabled in this first uncertainty experiment.',
                            'high is a model label, not a calibrated probability.']}


def render_review(report, registry, root):
    cells, source_rows = registry['cells'], registry['rows']
    sections = []
    for row in report['rows']:
        if not row['needsReview']:
            continue
        values = row['values']
        details = []
        for issue in row['issues']:
            label = LABELS[issue['field']] if issue['field'] >= 0 else '行对应关系／未定位字段'
            refs = []
            for ref in issue['refs']:
                source = cells.get(ref) or source_rows.get(ref)
                if not source:
                    refs.append(escape(ref) + '（来源不存在）')
                    continue
                text = source.get('text', ' | '.join(source.get('cells', [])))
                image = (Path('tmp/qwen-pagewise-upright/images') / f'upright-{source["page"]:02d}.jpg').resolve().as_uri()
                location = source.get('location', ref)
                refs.append(f'<a href="{escape(image)}" target="_blank">第{source["page"]}页 {escape(location)}</a>：{escape(text)}')
            details.append(f'<li><strong>{label}</strong> [{issue["stage"]}] {escape(issue["reason"])}<br><small>{"<br>".join(refs)}</small></li>')
        title = f'第 {row["outputRow"]} 笔 · {values[4] or "日期缺失"} · {values[5]} {values[6]} · {values[9] or "对方名称空白"}'
        status = '优先检查' if row['priorityReview'] else '一般检查'
        priority_attr = 'true' if row['priorityReview'] else 'false'
        sections.append(f'<details data-priority="{priority_attr}"><summary><b>{status}</b> {escape(title)}</summary><p>本方账号：{escape(values[0])}　对方账号：{escape(values[10])}　余额：{escape(values[7])}</p><ul>{"".join(details)}</ul></details>')
    flags = ''.join(f'<li>第 {p["page"]} 页：{escape(str(p.get("reasons", [])))}</li>' for p in report['pageFlags'])
    total = len(report['rows']); count = sum(r['needsReview'] for r in report['rows']); priority = sum(r['priorityReview'] for r in report['rows'])
    html = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>流水待检查清单</title>
<style>body{{max-width:1100px;margin:40px auto;padding:0 24px;font:16px/1.6 system-ui;color:#213047;background:#f6f8fa}}details{{background:white;padding:14px 20px;margin:10px 0;border:1px solid #dde3ea;border-radius:8px}}summary{{cursor:pointer}}small{{color:#556574;overflow-wrap:anywhere}}li{{margin:10px 0}}b{{color:#9a4a00}}a{{color:#1265a8}}button{{padding:8px 16px;margin-right:8px;cursor:pointer;border:1px solid #bdc8d4;border-radius:6px;background:white;font:inherit}}</style>
<h1>流水待检查清单</h1><p>共 {total} 笔，标记 {count} 笔，其中优先检查 {priority} 笔。点击展开字段与原文来源，再点击页码查看完整原页。</p>
<p>检查程序仅接收识别结果及原文来源，不接收标准答案。“未发现异常”不等于已经确认正确。页面显示的是候选流水，未自动修改数字或账号。</p>
<h2>页级提示</h2><ul>{flags or '<li>模型未报告页级完整性问题；尚未独立证明无漏行。</li>'}</ul>
<h2>逐笔检查</h2><p><button onclick="showRows(true)">优先检查 {priority} 笔</button><button onclick="showRows(false)">全部提示 {count} 笔</button></p>{''.join(sections)}
<script>function showRows(priorityOnly){{document.querySelectorAll('details[data-priority]').forEach(function(item){{item.hidden=priorityOnly&&item.dataset.priority!=='true';}});}}showRows(true);</script></html>'''
    (root / 'review.html').write_text(html, encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--stage2-dir', default='stage2')
    parser.add_argument('--signals-name', default='review-signals.json')
    args = parser.parse_args()
    registry = json.loads((args.root / 'source-registry.json').read_text())
    pages = json.loads((args.root / 'stage2-input.json').read_text())
    rows = json.loads((args.root / args.stage2_dir / 'structured.json').read_text())['rows']
    report = build_review(rows, registry, pages)
    path = args.root / args.signals_name
    if path.exists():
        raise SystemExit('Review signals already exist; use a new output location to preserve the blind evaluation')
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    render_review(report, registry, args.root)
    print(json.dumps({'rows': len(rows), 'flagged': sum(r['needsReview'] for r in report['rows']),
                      'priority': sum(r['priorityReview'] for r in report['rows']),
                      'pageFlags': len(report['pageFlags'])}))


if __name__ == '__main__':
    main()

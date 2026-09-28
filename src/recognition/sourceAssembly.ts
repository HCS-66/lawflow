import { normalizePrintedNumberSpacing } from './sourceFragments';
/** Source-bound assembly. This module receives observations, never a gold answer. */
export const STATEMENT_COLUMNS = ['accountNumber', 'accountName', 'bankName', 'transactionTime',
  'transactionDate', 'direction', 'amount', 'balance', 'transactionType', 'counterpartyName',
  'counterpartyAccount', 'counterpartyBank'] as const;
export type StatementColumn = typeof STATEMENT_COLUMNS[number];
export type SourceSelection = number | { id: number; text: string; line?: number };
export interface SourceCell { id: number; text: string; page: number; row: number | null; column: number | null }
export interface SourceRow { id: number; page: number; table: number; row: number; cells: number[] }
export interface SourceRegistry { cells: Record<string, SourceCell>; rows: Record<string, SourceRow>; pages: number[] }
export interface AssemblyRow { r: number[]; f: SourceSelection[][]; d: string; t: string }
export interface AssemblyPlan {
  rows: AssemblyRow[];
  ignored: Array<{ r: number[]; kind: 'header' | 'account' | 'total' | 'blank' | 'no_transactions' | 'other' }>;
}
export interface AssemblyIssue {
  id: string;
  code: string;
  field: StatementColumn | null;
  outputRows: number[];
  sourceRows: number[];
  sourceCells: number[];
  sourcePages?: number[];
  severity: 'REQUIRED' | 'AUTOMATIC_CHECK' | 'ADVISORY';
  message: string;
}
export interface AssembledRow {
  id: string;
  values: string[];
  sourceRows: number[];
  fields: Array<Array<{ id: number; text: string; normalized: string | null; line?: number }>>;
}
export interface AssemblyResult { rows: AssembledRow[]; issues: AssemblyIssue[]; complete: boolean }
const TYPES = new Set(['账户转账', '存款结息', '手续费', '工资收入', '司法扣划', '保险支出', '贷款放款',
  '贷款还款', '信用卡还款', '消费', '退款', '缴费', '第三方支付', '分期', '分期转换', '分期退款', '费用减免', '违约金', '透支利息', '现金存入', '现金支取']);
const KEY_FIELDS = new Set([0, 5, 6, 7, 10]);
const EMPTY = /^(?:\s*|[（(]空[）)]|无|--?|—|N\/A|null)$/i;

export function moneyFromSource(text: string, absolute = false): string | null {
  let s = normalizePrintedNumberSpacing(text.replace(/[−－]/g, '-').replace(/，/g, ',').replace(/^[￥¥]/, ''));
  if (EMPTY.test(s)) return '';
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s)) return null;
  s = s.replace(/,/g, '');
  const negative = s.startsWith('-') && !absolute;
  const [whole, fraction = ''] = s.replace(/^[+-]/, '').split('.');
  const digits = whole.replace(/^0+(?=\d)/, '');
  const cents = fraction.padEnd(2, '0');
  return `${negative && (digits !== '0' || cents !== '00') ? '-' : ''}${digits}.${cents}`;
}

export function accountFromSource(text: string): string | null {
  if (EMPTY.test(text.trim())) return '';
  const s = text.replace(/\s/g, '');
  if (/^尾号\d{2,8}$/.test(s)) return s;
  // Masking is a fact, not enough information to restore the hidden characters.
  if (/^[\d*＊xX]{8,32}$/.test(s)) return s.replace(/＊/g, '*');
  const matches = [...s.matchAll(/(?<!\d)\d{8,32}(?!\d)/g)];
  return matches.length === 1 ? matches[0][0] : null;
}

export function dateFromSource(text: string): string | null {
  if (EMPTY.test(text.trim())) return '';
  const m = text.match(/(?<!\d)((?:19|20)\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?!\d)/)
    || text.match(/(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?=\d{6}(?!\d)|\s|$)/);
  if (!m) return null;
  const [y, month, day] = m.slice(1).map(Number);
  const d = new Date(Date.UTC(y, month - 1, day));
  return d.getUTCFullYear() === y && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
    ? `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}

function timeFromSource(text: string): string | null {
  const m = text.match(/(?<!\d)([0-2]?\d):([0-5]\d):([0-5]\d)(?!\d)/)
    || text.match(/(?<!\d)(?:\d{8})?([0-2]\d)([0-5]\d)([0-5]\d)(?!\d)/);
  return m && Number(m[1]) <= 23 ? m.slice(1).map(x => x.padStart(2, '0')).join(':') : null;
}

function directionFromSource(text: string): string | null {
  const s = normalizePrintedNumberSpacing(text);
  if (['IN', '+', '收入', '转入', '贷', '贷方', '存入'].includes(s)) return 'IN';
  if (['OUT', '-', '支出', '转出', '借', '借方', '支取'].includes(s)) return 'OUT';
  if (/^[+-]/.test(s) && moneyFromSource(s) !== null) return s[0] === '-' ? 'OUT' : 'IN';
  return null; // Numeric bank codes require independently checked semantics.
}

export function bankFromSource(text: string): string {
  const names: Array<[RegExp, string]> = [[/工商银行|^工行/, '中国工商银行'], [/农业银行|^农行/, '中国农业银行'],
    [/建设银行|^建行$/, '中国建设银行'], [/中国银行|^中行$/, '中国银行'], [/光大银行/, '中国光大银行'],
    [/邮政储蓄银行/, '中国邮政储蓄银行'], [/民生银行/, '中国民生银行'], [/兴业银行/, '兴业银行'], [/平安银行/, '平安银行'],
    [/绵阳农村商业银行/, '四川绵阳农村商业银行'], [/绵阳市?商业银行|^绵商银行$/, '绵阳市商业银行']];
  return names.find(([pattern]) => pattern.test(text))?.[1] || text.trim();
}

function normalize(field: number, text: string): string | null {
  if (field === 0 || field === 10) return accountFromSource(text);
  if (field === 6 || field === 7) return moneyFromSource(text, field === 6);
  if (field === 4) return dateFromSource(text);
  if (field === 5) return directionFromSource(text);
  if (field === 2 || field === 11) return EMPTY.test(text.trim()) ? '' : bankFromSource(text);
  if ((field === 1 || field === 9) && /^[@*＊—-]+$/.test(text.trim())) return '';
  return EMPTY.test(text.trim()) ? '' : text.trim();
}

export function assembleFromSources(plan: AssemblyPlan, registry: SourceRegistry): AssemblyResult {
  if (!plan || !Array.isArray(plan.rows) || !Array.isArray(plan.ignored)) throw new Error('Invalid assembly plan');
  const rows: AssembledRow[] = [], issues: AssemblyIssue[] = [];
  const use = new Map<number, number[]>(), dispositions = new Map<number, string>();
  const add = (code: string, field: number | null, outputRows: number[], sourceRows: number[], sourceCells: number[],
    message: string, severity: AssemblyIssue['severity'] = 'REQUIRED') => {
    issues.push({ id: `I${issues.length + 1}`, code, field: field === null ? null : STATEMENT_COLUMNS[field],
      outputRows: [...new Set(outputRows)], sourceRows: [...new Set(sourceRows)], sourceCells: [...new Set(sourceCells)], severity, message });
  };
  for (const ignored of plan.ignored) {
    if (!Array.isArray(ignored.r) || !['header', 'account', 'total', 'blank', 'no_transactions', 'other'].includes(ignored.kind)) throw new Error('Invalid ignored rows');
    for (const id of ignored.r) {
      if (!registry.rows[id]) { add('INVALID_IGNORED_ROW', null, [], [id], [], '非交易行引用不存在'); continue; }
      if (dispositions.has(id)) add('DUPLICATE_DISPOSITION', null, [], [id], [], '同一原行被重复排除');
      dispositions.set(id, ignored.kind);
      const cells = registry.rows[id].cells.map(c => registry.cells[c].text);
      if (ignored.kind === 'blank' && cells.some(c => !EMPTY.test(c.trim()))) add('NONEMPTY_IGNORED_ROW', null, [], [id], [], '有内容的原行被标为空白');
      if (cells.some(c => dateFromSource(c)) && cells.some(c => /[.,]/.test(c) && moneyFromSource(c) !== null)
        && !['total', 'account'].includes(ignored.kind)) add('POSSIBLE_OMITTED_TRANSACTION', null, [], [id], [], '被排除的原行同时含日期和金额，需要独立确认行性质');
    }
  }
  plan.rows.forEach((item, index) => {
    const number = index + 1;
    if (!Array.isArray(item.r) || !item.r.length || !item.r.every(Number.isInteger)
      || !Array.isArray(item.f) || item.f.length !== 12 || !item.f.every(Array.isArray)
      || typeof item.d !== 'string' || typeof item.t !== 'string') throw new Error(`Invalid assembly row ${number}`);
    for (const id of item.r) {
      if (!registry.rows[id]) add('INVALID_ROW_SOURCE', null, [number], [id], [], '交易引用的原行不存在');
      use.set(id, [...(use.get(id) || []), number]);
      if (dispositions.has(id)) add('TRANSACTION_IGNORED_CONFLICT', null, [number], [id], [], '同一原行同时被用作交易和非交易');
    }
    const fields = item.f.map((selections, field) => selections.flatMap(selection => {
      const id = typeof selection === 'number' ? selection : selection?.id;
      const cell = registry.cells[id];
      if (!Number.isInteger(id) || !cell) { add('INVALID_CELL_SOURCE', field, [number], item.r, [id], '字段引用的原格不存在'); return []; }
      let text = cell.text;
      if (typeof selection !== 'number') {
        const lineMatches = selection.line !== undefined && Number.isInteger(selection.line) && selection.line >= 0
          && text.split(/\r?\n|\\n/)[selection.line]?.trim() === selection.text;
        if (typeof selection.text !== 'string' || !selection.text || !text.includes(selection.text)
          || (selection.line !== undefined ? !lineMatches : text.indexOf(selection.text) !== text.lastIndexOf(selection.text))) {
          add('INVALID_SOURCE_FRAGMENT', field, [number], item.r, [id], '指定片段未在原格中唯一逐字出现'); return [];
        }
        text = selection.text;
      }
      const metadata = cell.row !== null && ['header', 'account'].includes(dispositions.get(cell.row) || '');
      const ownBank = (field === 9 || field === 11) && item.f[2].some(s => (typeof s === 'number' ? s : s.id) === id)
        && ['手续费', '分期', '分期转换', '费用减免', '违约金', '透支利息', '存款结息'].includes(item.t);
      if (cell.row !== null && !item.r.includes(cell.row) && !(field <= 2 && metadata) && !ownBank) {
        add('OUTSIDE_TRANSACTION_SOURCES', field, [number], [...item.r, cell.row], [id], '字段来自未归入该交易的原行');
      }
      return [{ id, text, normalized: normalize(field, text), ...(typeof selection !== 'number' && selection.line !== undefined ? { line: selection.line } : {}) }];
    }));
    const values = fields.map(f => f[0]?.normalized ?? '');
    for (const field of [0, 6]) {
      if (!fields[field].length || !values[field]) add('MISSING_KEY_SOURCE', field, [number], item.r, [], '必要关键字段缺少可读取来源');
    }
    for (const field of KEY_FIELDS) {
      if (fields[field].some(s => s.normalized === null) && field !== 5) add('UNREADABLE_SOURCE', field, [number], item.r,
        fields[field].filter(s => s.normalized === null).map(s => s.id), '现有规则无法从原格提取该关键字段');
      const candidates = new Set(fields[field].map(s => s.normalized).filter(s => s !== null && s !== ''));
      if (candidates.size > 1) add('SOURCE_VALUE_CONFLICT', field, [number], item.r, fields[field].map(s => s.id), '同笔字段在不同原文观察中给出不同值');
    }
    if (!['', 'IN', 'OUT'].includes(item.d)) add('INVALID_DIRECTION', 5, [number], item.r, [], '方向不在允许值中');
    if (values[5] && item.d && values[5] !== item.d) add('DIRECTION_CONTRADICTION', 5, [number], item.r, fields[5].map(s => s.id), '方向解释与明确原文标记不一致');
    if (!values[5]) {
      values[5] = ['IN', 'OUT'].includes(item.d) ? item.d : '';
      add('DIRECTION_REQUIRES_INDEPENDENT_READ', 5, [number], item.r, fields[5].map(s => s.id), '数字借贷代码或缺失标记需要独立核实', values[5] && fields[5].length ? 'AUTOMATIC_CHECK' : 'REQUIRED');
    }
    const dates = fields[3].map(s => dateFromSource(s.text)).filter((s): s is string => Boolean(s));
    const times = fields[3].map(s => timeFromSource(s.text)).filter((s): s is string => Boolean(s));
    const chosenDate = dates[0] || values[4];
    values[3] = chosenDate && times[0] ? `${chosenDate} ${times[0]}` : '';
    if (new Set(dates).size > 1 || new Set(times).size > 1) add('TIME_SOURCE_CONFLICT', 3, [number], item.r, fields[3].map(s => s.id), '同笔交易的日期或时分秒来源不一致');
    if (fields[4].some(s => s.normalized === null)) add('PARTIAL_DATE', 4, [number], item.r, fields[4].map(s => s.id), '原文日期不完整或无效');
    values[8] = TYPES.has(item.t) ? item.t : '';
    if (item.t && !TYPES.has(item.t)) add('INVALID_TYPE', 8, [number], item.r, [], '交易类型不在标准词表');
    if (item.t && !fields[8].length) add('MISSING_TYPE_SOURCE', 8, [number], item.r, [], '分类没有原文依据');
    if (item.t === '第三方支付' && fields[8].some(s => /消费/.test(s.text))) add('TYPE_SOURCE_CONTRADICTION', 8, [number], item.r, fields[8].map(s => s.id), '原文消费被改成支付渠道类型');
    if (!values[10] && !values[9]) add('COUNTERPARTY_IDENTITY_MISSING', 9, [number], item.r, [], '对方账号和名称均缺失，需确认原文是否提供身份信息');
    if (!values[10] && new Set(fields[9].map(s => s.normalized).filter(Boolean)).size > 1) add('COUNTERPARTY_NAME_CONFLICT', 9, [number], item.r, fields[9].map(s => s.id), '没有对方账号且姓名候选不一致');
    rows.push({ id: `T${number}`, values, sourceRows: [...new Set(item.r)], fields });
  });
  for (const [id, outputs] of use) if (outputs.length > 1) add('SOURCE_ROW_REUSED', null, outputs, [id], [], '同一原行用于多笔输出，可能重复或错误拆分');
  for (const source of Object.values(registry.rows)) if (!use.has(source.id) && !dispositions.has(source.id)) add('UNASSIGNED_SOURCE_ROW', null, [], [source.id], [], '原行没有交易或非交易去向');
  return { rows, issues, complete: !issues.some(i => ['INVALID_ROW_SOURCE', 'INVALID_CELL_SOURCE', 'UNASSIGNED_SOURCE_ROW',
    'SOURCE_ROW_REUSED', 'TRANSACTION_IGNORED_CONFLICT', 'DUPLICATE_DISPOSITION'].includes(i.code)) };
}

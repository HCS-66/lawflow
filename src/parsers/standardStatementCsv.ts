import type { BankAccount, StandardTransaction } from '../types/transaction';
import { STATEMENT_COLUMNS } from '../recognition/sourceAssembly';
import { chronologicalTransactions } from '../utils/transactionSequence';

/** Exact 12-column contract. No fuzzy header matching, account guessing or row dropping. */
export function parseStandardStatementRows(rows: unknown[][], fileName: string) {
  const header = rows[0]?.map(value => String(value).replace(/^\uFEFF/, '').trim()) || [];
  if (!header.some(value => STATEMENT_COLUMNS.includes(value as typeof STATEMENT_COLUMNS[number]))) return null;
  if (header.length !== STATEMENT_COLUMNS.length || header.some((value, i) => value !== STATEMENT_COLUMNS[i])) {
    throw new Error('标准流水CSV的12列名称或顺序不匹配，请按标准模版导入。');
  }
  const transactions: StandardTransaction[] = [];
  for (let i = 1; i < rows.length; i++) {
    const values = rows[i].map(value => String(value ?? '').trim());
    if (values.every(value => !value)) continue;
    if (values.length !== 12) throw new Error(`标准流水第${i + 1}行不是12列，请检查分隔符。`);
    const money = (value: string, label: string, optional = false) => {
      if (optional && value === '') return 0;
      if (!/^-?\d+(?:\.\d{1,2})?$/.test(value) || !Number.isFinite(Number(value))) {
        throw new Error(`标准流水第${i + 1}行的${label}不是有效金额。`);
      }
      return Number(value);
    };
    const amount = money(values[6], '金额');
    if (amount < 0) throw new Error(`标准流水第${i + 1}行金额应为非负数，收支由方向列表示。`);
    if (!['IN', 'OUT', ''].includes(values[5])) throw new Error(`标准流水第${i + 1}行收支方向应为IN或OUT。`);
    const issues: NonNullable<StandardTransaction['dataQualityIssues']> = [];
    const parsed = new Date(`${values[4]}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values[4]) || !Number.isFinite(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== values[4]) issues.push('INVALID_DATE');
    if (!values[5]) issues.push('UNKNOWN_DIRECTION');
    transactions.push({ id: `standard-${i}-${fileName}`, recognitionPolicy: 'EVIDENCE_ONLY_V1',
      accountNumber: values[0], accountName: values[1], bankName: values[2], transactionTime: values[3],
      transactionDate: values[4], direction: values[5] === 'IN' ? 'IN' : values[5] === 'OUT' ? 'OUT' : 'UNKNOWN',
      amount, balance: money(values[7], '余额', true), balanceAvailable: values[7] !== '',
      transactionType: values[8], counterpartyName: values[9], counterpartyAccount: values[10], counterpartyBank: values[11],
      summary: '', rawSourceFile: fileName, rawRowIndex: i + 1, reviewStatus: 'PENDING',
      dataQualityIssues: issues.length ? issues : undefined });
  }
  if (!transactions.length) throw new Error('这份标准流水只有表头，没有交易记录。');
  const groups = new Map<string, StandardTransaction[]>();
  for (const row of transactions) {
    const key = JSON.stringify([row.accountNumber, row.bankName]);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const accounts: BankAccount[] = [...groups.values()].map(group => {
    const ordered = chronologicalTransactions(group), first = ordered[0], last = ordered[ordered.length - 1];
    const cents = (value: number) => Math.round(value * 100);
    const totalIn = group.filter(r => r.direction === 'IN').reduce((s, r) => s + cents(r.amount), 0);
    const totalOut = group.filter(r => r.direction === 'OUT').reduce((s, r) => s + cents(r.amount), 0);
    const start = cents(first.balance) + (first.direction === 'IN' ? -1 : first.direction === 'OUT' ? 1 : 0) * cents(first.amount);
    const available = group.every(r => r.balanceAvailable && r.direction !== 'UNKNOWN' && !r.dataQualityIssues?.includes('INVALID_DATE'));
    const diff = start + totalIn - totalOut - cents(last.balance);
    return { accountNumber: first.accountNumber, accountName: first.accountName, bankName: first.bankName,
      ownerType: 'UNKNOWN', fileName, fileType: 'csv', totalIn: totalIn / 100, totalOut: totalOut / 100,
      transactionCount: group.length, startDate: first.transactionDate, endDate: last.transactionDate,
      startBalance: start / 100, endBalance: last.balance, isBalanced: available && diff === 0,
      balanceDiff: diff / 100, balanceAvailable: available, parseStatus: 'NEEDS_REVIEW',
      parseWarnings: ['标准CSV保留原有12列；文件本身不包含PDF原件或人工确认记录，请结合核对记录使用。'] };
  });
  return { account: accounts[0], accounts, transactions };
}

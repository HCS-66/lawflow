import type { BankAccount, StandardTransaction, TransactionEvidenceField, EvidenceReviewIssue } from '../types/transaction';
import { STATEMENT_COLUMNS, type SourceRegistry } from './sourceAssembly';
import type { QualityDeliveryInput } from '../review/qualityDelivery';
import type { TableMappingPlan } from './tableMapping';
import { chronologicalTransactions } from '../utils/transactionSequence';

export const QUALITY_EXTRACTION = 'QWEN_GEMINI_QUALITY' as const;
export function summarizeQualityAccounts(transactions: StandardTransaction[], originals: BankAccount[]): BankAccount[] {
  const groups = new Map<string, StandardTransaction[]>();
  for (const row of transactions) {
    const key = JSON.stringify([row.sourceDocumentId || row.rawSourceFile, row.accountNumber]);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const accounts: BankAccount[] = [...groups.values()].map(rows => {
    const first = rows[0];
    const original = originals.find(a => a.accountNumber === first.accountNumber && (a.sourceDocumentId && first.sourceDocumentId
      ? a.sourceDocumentId === first.sourceDocumentId : a.fileName === first.rawSourceFile));
    const dates = rows.map(r => r.transactionDate).filter(Boolean).sort();
    const ordered = chronologicalTransactions(rows);
    const total = (direction: string) => rows.filter(r => r.direction === direction).reduce((sum, r) => sum + Math.round(r.amount * 100), 0) / 100;
    const totalIn = total('IN'), totalOut = total('OUT');
    const balanceAvailable = rows.every(r => r.balanceAvailable !== false && r.direction !== 'UNKNOWN');
    const start = ordered[0], end = ordered[ordered.length - 1];
    const startBalance = start.balance - (start.direction === 'IN' ? start.amount : start.direction === 'OUT' ? -start.amount : 0);
    const endBalance = end.balance, balanceDiff = Math.abs(Math.round((startBalance + totalIn - totalOut - endBalance) * 100)) / 100;
    return { ...original, accountNumber: first.accountNumber, accountName: first.accountName, bankName: first.bankName,
      ownerType: original?.ownerType || 'UNKNOWN', fileName: first.rawSourceFile, fileType: 'pdf',
      totalIn, totalOut, transactionCount: rows.length, startDate: dates[0] || '', endDate: dates.at(-1) || '',
      startBalance, endBalance, balanceAvailable, balanceDiff, isBalanced: balanceAvailable && balanceDiff === 0,
      qualityPipeline: true, coveredPages: [...new Set(rows.map(r => r.rawPageNumber).filter((p): p is number => !!p))],
      parseStatus: original?.parseStatus === 'INCOMPLETE' ? 'INCOMPLETE'
        : rows.some(r => r.candidateReview && r.candidateReview.status !== 'CONFIRMED') || original?.reviewIssues?.some(i => i.severity === 'REQUIRED' && ['PENDING', 'UNRESOLVED'].includes(i.status)) ? 'NEEDS_REVIEW' : 'COMPLETE'
    } satisfies BankAccount;
  });
  // Preserve document-level coverage tasks even when no transactions could be read.
  for (const original of originals) if (!accounts.some(a => a.accountNumber === original.accountNumber && a.fileName === original.fileName)
    && !transactions.some(t => t.rawSourceFile === original.fileName)) accounts.push(original);
  return accounts;
}

export function qualityToWeb(result: QualityDeliveryInput, registry: SourceRegistry, fileName: string, totalPages: number, mapping?: TableMappingPlan) {
  const run = crypto.randomUUID();
  const transactions: StandardTransaction[] = result.rows.map((row, index) => {
    const [accountNumber, accountName, bankName, transactionTime, transactionDate, direction, amount, balance, transactionType, counterpartyName, counterpartyAccount, counterpartyBank] = row.values;
    const sources = row.sourceObservationIds.filter(s => s.startsWith('source:')).map(s => registry.rows[s.slice(7)]).filter(Boolean);
    const kinds = new Set(sources.map(s => mapping?.tables.find(t => t.page === s.page && t.table === s.table)?.accountKind));
    const sourceAccountKind = kinds.size === 1 ? [...kinds][0] : undefined;
    const pending = result.pending.filter(i => i.severity !== 'ADVISORY' && i.outputRows.includes(index + 1));
    const requiredFields = [...new Set(pending.flatMap(i => i.field ? [i.field] : [...STATEMENT_COLUMNS]))] as TransactionEvidenceField[];
    const transaction: StandardTransaction = {
      id: `${run}:${row.id}`, recognitionPolicy: 'EVIDENCE_ONLY_V1', extractionMethod: QUALITY_EXTRACTION,
      sourceAccountKind,
      accountNumber, accountName, bankName, transactionTime, transactionDate, direction: direction === 'IN' || direction === 'OUT' ? direction : 'UNKNOWN',
      amount: amount === '' ? 0 : Number(amount), balance: balance === '' ? 0 : Number(balance), balanceAvailable: balance !== '',
      transactionType, counterpartyName, counterpartyAccount, counterpartyBank, summary: '', rawSourceFile: fileName,
      rawPageNumber: sources[0]?.page, rawRowIndex: sources[0]?.row,
      qualitySourceObservationIds: row.sourceObservationIds, rawText: sources.map(r => r.cells.map(id => registry.cells[id].text).join(' | ')).join('\n'),
      reviewStatus: pending.length ? 'PENDING' : 'AUTO_PASSED',
      candidateReview: pending.length ? { kind: 'SOURCE_CHECK', requiredFields, differences: [], status: 'PENDING',
        reason: pending.map(i => i.message).join('；') } : undefined,
      dataQualityIssues: [!transactionDate ? 'INVALID_DATE' as const : undefined, !amount || !Number.isFinite(Number(amount)) ? 'INVALID_AMOUNT' as const : undefined,
        !['IN', 'OUT'].includes(direction) ? 'UNKNOWN_DIRECTION' as const : undefined].filter((x): x is NonNullable<typeof x> => !!x)
    };
    transaction.fieldEvidence = Object.fromEntries(STATEMENT_COLUMNS.map((field, col) => [field, {
      originalValue: (field === 'amount' || field === 'balance') && row.values[col] !== '' ? Number(row.values[col]) : row.values[col],
      currentValue: transaction[field] ?? '', origin: 'EXTRACTION',
      decision: requiredFields.includes(field) ? 'UNRESOLVED' : 'ACCEPTED', reason: pending.filter(i => i.field === field).map(i => i.message).join('；')
    }]));
    return transaction;
  });
  const documentIssues: EvidenceReviewIssue[] = result.pending.filter(i => !i.outputRows.length).map(i => ({
    id: `${run}:${i.id}`, category: 'PAGE_INTEGRITY', severity: i.severity === 'ADVISORY' ? 'ADVISORY' : 'REQUIRED',
    title: i.severity === 'ADVISORY' ? '页面读取提示' : result.complete ? '页面完整性待确认' : 'PDF 解析不完整', description: i.message,
    instructions: ['对照完整原件核对相关页面和交易行数', '如有遗漏，请重新识别或补录'],
    pageNumber: i.sourcePages?.[0] || registry.rows[i.sourceRows[0]]?.page || registry.cells[i.sourceCells[0]]?.page,
    transactionIds: [], status: 'PENDING'
  }));
  if (!result.complete && !documentIssues.some(i => i.severity === 'REQUIRED')) documentIssues.push({
    id: `${run}:incomplete`, category: 'PAGE_INTEGRITY', severity: 'REQUIRED', title: 'PDF 解析不完整',
    description: '页面覆盖或交易行数存在未解决差异，请核对原件。', instructions: ['核对标出的页面与交易行数'], transactionIds: [], status: 'PENDING'
  });
  const base = transactions[0];
  const documentAccount: BankAccount = {
    accountNumber: base?.accountNumber || `待归属页面-${fileName}`, accountName: base?.accountName || '待归属页面', bankName: base?.bankName || '',
    fileName, fileType: 'pdf', ownerType: 'UNKNOWN', totalIn: 0, totalOut: 0, transactionCount: 0, startDate: '', endDate: '', startBalance: 0, endBalance: 0,
    isBalanced: false, balanceDiff: 0, balanceAvailable: false, totalPages, coveredPages: registry.pages, qualityPipeline: true,
    parseStatus: result.complete ? documentIssues.length ? 'NEEDS_REVIEW' : 'COMPLETE' : 'INCOMPLETE', reviewIssues: documentIssues
  };
  const accounts = summarizeQualityAccounts(transactions, [documentAccount]);
  for (const account of accounts) account.totalPages = totalPages;
  return { accounts, transactions };
}

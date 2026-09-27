import type { StandardTransaction, BankAccount } from '../types/transaction';

type EvaluatedField = 'accountNumber' | 'transactionTime' | 'transactionDate' | 'direction' | 'amount' | 'balance'
  | 'counterpartyAccount' | 'counterpartyName' | 'transactionType';
export interface RecognitionGroundTruth {
  version: 1;
  status: 'SOURCE_CHECKED';
  reviewedBy: string;
  documents: Array<{
    documentId: string;
    /** Optional full document account inventory, including zero-transaction accounts. */
    accountNumbers?: string[];
    /** All transaction rows on these pages must be annotated, including zero-row pages. */
    completePages: number[];
    rows: Array<{ page: number; row: number; fields: Partial<Pick<StandardTransaction, EvaluatedField>> }>;
  }>;
}

/** Evaluate only source-checked pages. Model output must never become ground truth automatically. */
export function evaluateRecognition(transactions: StandardTransaction[], truth: RecognitionGroundTruth, accounts?: BankAccount[]) {
  if (truth.version !== 1 || truth.status !== 'SOURCE_CHECKED' || !truth.reviewedBy?.trim() || !truth.documents?.length) {
    throw new Error('需要标注版本、人工核对人及 SOURCE_CHECKED 状态；识别结果不能自动作为标准答案');
  }
  let expectedRows = 0;
  let predictedRows = 0;
  let matchedRows = 0;
  let correctFields = 0;
  let comparedFields = 0;
  let wrongAccounts = 0;
  let exactRows = 0;
  let extraAccounts = 0;
  let missingAccounts = 0;
  const errors: Array<{ documentId: string; page: number; row: number; field: string; expected: unknown; actual: unknown; reason?: string }> = [];
  const seen = new Set<string>();
  for (const document of truth.documents) {
    if (seen.has(document.documentId)) throw new Error('标准答案重复包含同一个来源文件');
    seen.add(document.documentId);
    if (document.accountNumbers) {
      if (!accounts) throw new Error('标准答案包含账户清单，评估时必须提供全部账户');
      const expectedAccounts = new Set(document.accountNumbers);
      const foundAccounts = new Set(accounts.filter(a => a.sourceDocumentId === document.documentId
        && !/待归属|待核验|待核对/.test(a.accountNumber)).map(a => a.accountNumber));
      for (const number of expectedAccounts) if (!foundAccounts.has(number)) {
        missingAccounts++;
        errors.push({ documentId: document.documentId, page: 0, row: 0, field: 'missingAccount', expected: number, actual: null });
      }
      for (const number of foundAccounts) if (!expectedAccounts.has(number)) {
        extraAccounts++;
        errors.push({ documentId: document.documentId, page: 0, row: 0, field: 'extraAccount', expected: null, actual: number });
      }
    }
    if (!document.documentId || !document.completePages.length) throw new Error('标准答案必须明确来源文件和已完整标注的页面');
    const pages = new Set(document.completePages);
    const actual = transactions.filter(row => row.sourceDocumentId === document.documentId && pages.has(row.rawPageNumber || 0));
    predictedRows += actual.length;
    const indexed = new Map<string, StandardTransaction[]>();
    for (const row of actual) {
      const key = `${row.rawPageNumber}:${row.rawRowIndex}`;
      indexed.set(key, [...(indexed.get(key) || []), row]);
    }
    const expectedKeys = new Set<string>();
    for (const expected of document.rows) {
      const key = `${expected.page}:${expected.row}`;
      if (!pages.has(expected.page) || !Number.isInteger(expected.row) || expected.row < 1
        || expectedKeys.has(key) || !Object.keys(expected.fields).length) {
        throw new Error('标准答案行必须位于完整标注页、定位唯一且包含已核对字段');
      }
      expectedKeys.add(key);
      expectedRows++;
      const matches = indexed.get(key) || [];
      const found = matches.length === 1 ? matches[0] : undefined;
      if (found) matchedRows++;
      else errors.push({ documentId: document.documentId, page: expected.page, row: expected.row,
        field: 'row', expected: 1, actual: matches.length });
      let exact = Boolean(found);
      for (const [field, value] of Object.entries(expected.fields) as Array<[EvaluatedField, string | number]>) {
        comparedFields++;
        const actualValue = found?.[field];
        const readable = Boolean(found)
          && !(field === 'balance' && found?.balanceAvailable === false)
          && !(field === 'amount' && found?.dataQualityIssues?.includes('INVALID_AMOUNT'));
        const equal = readable && (typeof value === 'number'
          ? typeof actualValue === 'number' && Math.round(value * 100) === Math.round(actualValue * 100)
          : actualValue === value);
        if (equal) correctFields++;
        else {
          exact = false;
          if (field === 'accountNumber' && found) wrongAccounts++;
          errors.push({ documentId: document.documentId, page: expected.page, row: expected.row,
            field, expected: value, actual: actualValue ?? null,
            reason: !found ? 'MISSING_OR_DUPLICATE_ROW' : !readable ? 'UNREADABLE_VALUE' : 'VALUE_MISMATCH' });
        }
      }
      if (exact) exactRows++;
    }
    for (const row of actual) {
      if (!expectedKeys.has(`${row.rawPageNumber}:${row.rawRowIndex}`)) errors.push({
        documentId: document.documentId, page: row.rawPageNumber || 0, row: row.rawRowIndex || 0,
        field: 'extraRow', expected: null, actual: row.accountNumber
      });
    }
  }
  return { expectedRows, predictedRows, matchedRows, exactRows, correctFields, comparedFields, wrongAccounts, extraAccounts, missingAccounts,
    fieldAccuracy: comparedFields ? correctFields / comparedFields : null,
    exactRowRecall: expectedRows ? exactRows / expectedRows : null,
    exactRowPrecision: predictedRows ? exactRows / predictedRows : null,
    passed: errors.length === 0, errors };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExcelBankStatement } from '../src/parsers/excelParser';
import { parseStandardStatementRows } from '../src/parsers/standardStatementCsv';
import { STATEMENT_COLUMNS } from '../src/recognition/sourceAssembly';
import { normalizeRecognizedData } from '../src/utils/recognizedDataNormalizer';
import { classifyTransactionFlow } from '../src/engine/flowClassification';
import { isJudicialDeduction } from '../src/engine/bilateral';
import { isFeeWaiver, isCreditCardStatement } from '../src/utils/transactionSequence';

test('the 12-column CSV survives product import with identities, signed balances, zero amounts and classes intact', async () => {
  const values = [
    ['001234567890', '某甲', '示例银行', '2026-01-01 10:00:00', '2026-01-01', 'OUT', '10.00', '-90.00', '司法扣划', '某法院', '001100220033', ''],
    ['009876543210', '某甲', '示例银行', '2026-01-02', '2026-01-02', 'IN', '0.00', '0.00', '存款结息', '示例银行', '', '']
  ];
  const csv = '\uFEFF' + [STATEMENT_COLUMNS, ...values].map(r => r.join(',')).join('\r\n');
  const parsed = await parseExcelBankStatement(new File([csv], 'standard.csv'));
  assert.equal(parsed.accounts?.length, 2);
  assert.equal(parsed.transactions.length, 2);
  assert.equal(parsed.transactions[0].balance, -90);
  assert.equal(parsed.transactions[0].counterpartyAccount, '001100220033');
  const normalized = normalizeRecognizedData(parsed.accounts!, parsed.transactions);
  assert.equal(normalized.transactions[0].accountNumber, '001234567890');
  assert.equal(normalized.transactions[0].amount, 10);
  assert.equal(normalized.transactions[0].transactionType, '司法扣划');
  assert.equal(classifyTransactionFlow(normalized.transactions[0])?.code, 'JUDICIAL_DEDUCTION');
  assert.equal(isJudicialDeduction(normalized.transactions[0]), true);
});

test('invalid standard columns and money fail visibly; partial dates remain reviewable instead of disappearing', () => {
  const row = ['001234567890', '某甲', '示例银行', '', '2026-01', '', '1.00', '', '', '', '', ''];
  assert.throws(() => parseStandardStatementRows([STATEMENT_COLUMNS.slice(1), row], 'bad.csv'), /12列/);
  const parsed = parseStandardStatementRows([STATEMENT_COLUMNS, row], 'partial.csv')!;
  assert.equal(parsed.transactions.length, 1);
  assert.equal(parsed.transactions[0].transactionDate, '2026-01');
  assert.equal(parsed.transactions[0].balanceAvailable, false);
  assert.deepEqual(parsed.transactions[0].dataQualityIssues, ['INVALID_DATE', 'UNKNOWN_DIRECTION']);
  row[6] = '1.OO';
  assert.throws(() => parseStandardStatementRows([STATEMENT_COLUMNS, row], 'bad.csv'), /有效金额/);
});

test('standard types retain zero-fee and credit-balance semantics without turning a deposit repayment into a credit account', () => {
  const values = ['001234567890', '某甲', '示例银行', '2026-01-01', '2026-01-01', 'OUT', '0.00', '-90.00', '费用减免', '', '', ''];
  const tx = parseStandardStatementRows([STATEMENT_COLUMNS, values], 'typed.csv')!.transactions[0];
  assert.equal(isFeeWaiver(tx), true);
  assert.equal(isCreditCardStatement([{ ...tx, amount: 10, transactionType: '透支利息' }]), true);
  assert.equal(isCreditCardStatement([{ ...tx, balance: 90, amount: 10, transactionType: '信用卡还款' }]), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { LawFlowEngine } from '../src/engine/engine';
import { CaseMetadata } from '../src/types/case';
import { BankAccount, StandardTransaction } from '../src/types/transaction';
import { classifyTransactionFlow } from '../src/engine/flowClassification';
import { effectiveCounterpartyName } from '../src/engine/bilateral';
import { aggregateCounterparties } from '../src/engine/bilateral';
import { counterpartyIdentityKey } from '../src/engine/counterpartyIdentity';
import { accountIdentityKey } from '../src/utils/accountIdentity';

const metadata: CaseMetadata = {
  id: 'case-unified', caseNumber: '执1号', courtName: '测试法院', applicantName: '申请人',
  respondentName: '测试甲', targetAmount: 10000, createdAt: '2025-01-01', updatedAt: '2025-01-01',
  timeline: { executionFilingDate: '2025-01-01', customNodes: [] }, declaredAssets: []
};

function account(number: string): BankAccount {
  return {
    accountNumber: number, accountName: '测试甲', bankName: '测试银行', ownerType: 'DEBTOR_MAIN',
    fileName: 'source.pdf', fileType: 'pdf', totalIn: 0, totalOut: 0, transactionCount: 0,
    startDate: '2025-01-01', endDate: '2025-01-03', startBalance: 0, endBalance: 0,
    isBalanced: true, balanceDiff: 0, balanceAvailable: true, sourceDocumentId: 'doc-1'
  };
}

function transaction(id: string, accountNumber: string, direction: 'IN' | 'OUT', amount: number, balance: number, counterpartyName: string, summary = ''): StandardTransaction {
  return {
    id, accountNumber, accountName: '测试甲', bankName: '测试银行', transactionTime: '2025-01-02',
    transactionDate: '2025-01-02', direction, amount, balance, counterpartyName, summary,
    rawSourceFile: 'source.pdf', sourceDocumentId: 'doc-1', balanceAvailable: true
  };
}

test('unified analysis builds explicit entities and relations without mutating canonical rows', () => {
  const accounts = [account('A'), account('B')];
  const rows = [
    { ...transaction('out', 'A', 'OUT', 100, 0, '测试甲'), counterpartyAccount: 'B' },
    { ...transaction('in', 'B', 'IN', 100, 100, '测试甲'), counterpartyAccount: 'A' },
    transaction('judicial', 'B', 'OUT', 40, 60, '', '司法划扣')
  ];
  const canonicalSnapshot = JSON.stringify(rows);
  const engine = new LawFlowEngine();
  const { report, processedTransactions } = engine.evaluateCase(metadata, rows, accounts);

  assert.equal(JSON.stringify(rows), canonicalSnapshot);
  assert.equal(processedTransactions.filter(row => row.isInternalTransfer).length, 2);
  assert.equal(report.analysisGraph?.accounts.length, 2);
  assert.equal(report.analysisGraph?.transactions.length, 3);
  assert.equal(report.analysisGraph?.judicialDeductions.length, 1);
  assert.ok(report.analysisGraph?.flowCategories.some(category => category.code === 'JUDICIAL_DEDUCTION' && category.transactionIds.includes('judicial')));
  assert.ok(report.analysisGraph?.relationships.some(relation => relation.type === 'INTERNAL_TRANSFER_PAIR'));
  assert.ok(report.analysisGraph?.relationships.some(relation => relation.type === 'JUDICIAL_DEDUCTION_TO_AUTHORITY'));
  assert.ok(report.analysisGraph?.relationships.some(relation => relation.type === 'TRANSACTION_CLASSIFIED_AS' && relation.transactionIds.includes('judicial')));
  assert.equal(Object.keys(report.accountAudits || {}).length, 2);
});

test('fund flows classify legally important uses without a minimum amount threshold', () => {
  assert.equal(classifyTransactionFlow(transaction('j', 'A', 'OUT', 1, 0, '', '法院扣划'))?.code, 'JUDICIAL_DEDUCTION');
  assert.equal(classifyTransactionFlow(transaction('loan', 'A', 'IN', 300000, 300000, '', '个人贷款放款'))?.code, 'LOAN_DISBURSEMENT');
  assert.equal(classifyTransactionFlow(transaction('cash', 'A', 'OUT', 500, 0, '', 'ATM现金取款'))?.code, 'CASH_WITHDRAWAL');
  assert.equal(classifyTransactionFlow(transaction('wealth', 'A', 'OUT', 500, 0, '', '购买理财产品'))?.code, 'INVESTMENT_WEALTH');
  assert.equal(classifyTransactionFlow(transaction('fee', 'A', 'OUT', 10, 0, '', '账户管理费'))?.code, 'TAX_AND_FEES');
  assert.equal(classifyTransactionFlow(transaction('unknown', 'A', 'OUT', 10, 0, '', ''))?.code, 'OTHER_OUT');
});

test('network enforcement deductions are classified as judicial deductions instead of unknown transfers', () => {
  const networkDeduction = {
    ...transaction('network-judicial', 'A', 'OUT', 16903.99, 3.47, '网络查控定期及跨行扣划专户', '网络执行查控 扣划'),
    rawText: '2025-02-25 OUT 16903.99 网络执行查控 扣划 网络查控定期及跨行扣划专户'
  };
  assert.equal(classifyTransactionFlow(networkDeduction)?.code, 'JUDICIAL_DEDUCTION');
  assert.equal(effectiveCounterpartyName(networkDeduction), '【司法机关划扣】');
});

test('document review placeholders never become account entities or balance audits', () => {
  const placeholder: BankAccount = {
    ...account('待归属页面-流水.pdf'),
    accountName: '待归属页面', bankName: '待核对', ownerType: 'UNKNOWN', transactionCount: 0,
    parseStatus: 'INCOMPLETE', parseWarnings: ['第 2 页连续识别失败：服务暂时不可用']
  };
  const result = new LawFlowEngine().evaluateCase(metadata, [transaction('real', 'A', 'OUT', 10, 90, '甲')], [account('A'), placeholder]);
  assert.equal(result.report.analysisGraph?.accounts.length, 1);
  assert.equal(Object.keys(result.report.accountAudits || {}).length, 1);
});

test('changing any canonical transaction invalidates the analysis fingerprint and recomputes graph amounts', () => {
  const accounts = [account('A')];
  const rows = [transaction('judicial', 'A', 'OUT', 40, 60, '', '司法划扣')];
  const engine = new LawFlowEngine();
  const first = engine.evaluateCase(metadata, rows, accounts).report;
  const changed = rows.map(row => ({ ...row, amount: 55, balance: 45 }));
  const second = engine.evaluateCase(metadata, changed, accounts, first).report;

  assert.notEqual(first.analysisFingerprint, second.analysisFingerprint);
  assert.equal(second.totalRawOut, 55);
  assert.equal(second.analysisGraph?.judicialDeductions[0].amount, 55);

  const revisedAccount = [{ ...accounts[0], startBalance: 100 }];
  const third = engine.evaluateCase(metadata, changed, revisedAccount, second).report;
  assert.notEqual(second.analysisFingerprint, third.analysisFingerprint);
});

test('changing a standard CSV type invalidates the cached analysis and updates its financial use', () => {
  const accounts = [account('A')], engine = new LawFlowEngine();
  const row = { ...transaction('csv', 'A', 'OUT', 40, 60, ''), transactionType: '账户转账' };
  const first = engine.evaluateCase(metadata, [row], accounts).report;
  const next = engine.evaluateCase(metadata, [{ ...row, transactionType: '司法扣划' }], accounts, first).report;
  assert.notEqual(first.analysisFingerprint, next.analysisFingerprint);
  assert.equal(next.analysisGraph?.judicialDeductions.length, 1);
});

test('full counterparty accounts remain one identity across names; same names on different accounts stay separate', () => {
  const rows = [
    { ...transaction('a', 'A', 'OUT', 100, 900, '某甲'), counterpartyAccount: '0012345678901234' },
    { ...transaction('b', 'A', 'IN', 50, 950, '某甲（原文异体）'), counterpartyAccount: '0012345678901234' },
    { ...transaction('c', 'A', 'OUT', 30, 920, '某甲'), counterpartyAccount: '0012345678901235' }
  ];
  const report = new LawFlowEngine().evaluateCase(metadata, rows, [account('A')]).report;
  assert.equal(report.analysisGraph?.counterparties.length, 2);
  const summaries = aggregateCounterparties(rows);
  assert.equal(Object.keys(summaries).length, 2);
  const entity = summaries[counterpartyIdentityKey(rows[0])];
  assert.equal(entity.totalIn, 50); assert.equal(entity.totalOut, 100);
  assert.deepEqual(entity.transactionIds, ['a', 'b']);
  assert.deepEqual(entity.aliases, ['某甲', '某甲（原文异体）']);
  const masked = { ...rows[0], counterpartyAccount: '尾号1234' };
  assert.notEqual(counterpartyIdentityKey(masked), counterpartyIdentityKey(rows[0]));
});

test('recalculation preserves lawyer annotations only for the same stable rule match', () => {
  const accounts = [account('A')];
  const rows = [transaction('large', 'A', 'OUT', 60000, -60000, '收款人', '转账')];
  const engine = new LawFlowEngine();
  const first = engine.evaluateCase(metadata, rows, accounts).report;
  assert.ok(first.matches.length > 0);
  first.matches[0] = { ...first.matches[0], lawyerAdopted: true, lawyerNotes: '已核原件' };

  const second = engine.evaluateCase(metadata, rows, accounts, first).report;
  const retained = second.matches.find(match => match.matchId === first.matches[0].matchId);
  assert.equal(retained?.lawyerAdopted, true);
  assert.equal(retained?.lawyerNotes, '已核原件');

  const removed = engine.evaluateCase(metadata, [{ ...rows[0], amount: 100 }], accounts, second).report;
  assert.equal(removed.matches.some(match => match.matchId === first.matches[0].matchId), false);
});

test('cross-document duplicate observations become one transaction event without deleting source evidence', () => {
  const firstAccount = { ...account('6222000000004088'), fileName: 'first.pdf', sourceDocumentId: 'doc-first' };
  const secondAccount = { ...account('6222000000004088'), fileName: 'second.pdf', sourceDocumentId: 'doc-second' };
  const first = {
    ...transaction('first-row', firstAccount.accountNumber, 'OUT', 4000, 6497.36, '收款人', '跨行汇款'),
    transactionTime: '2025-01-02 09:23:02', rawSourceFile: 'first.pdf', sourceDocumentId: 'doc-first'
  };
  const second = {
    ...first, id: 'second-row', rawSourceFile: 'second.pdf', sourceDocumentId: 'doc-second'
  };

  const result = new LawFlowEngine().evaluateCase(metadata, [first, second], [firstAccount, secondAccount]);
  assert.equal(result.report.sourceObservationCount, 2);
  assert.equal(result.report.canonicalTransactionCount, 1);
  assert.equal(result.report.duplicateObservationCount, 1);
  assert.equal(result.report.totalRawOut, 4000);
  assert.equal(result.report.analysisGraph?.accounts.length, 1);
  assert.equal(result.report.analysisGraph?.transactions.length, 1);
  assert.equal(result.report.analysisGraph?.duplicateGroups.length, 1);
  assert.equal(result.processedTransactions.length, 2);
  assert.equal(result.processedTransactions.filter(row => row.excludedFromAnalysis).length, 1);
  assert.equal(new Set(result.processedTransactions.map(row => row.analysisEventId)).size, 1);
});

test('same-document duplicate observations remain stored but enter analysis only once', () => {
  const statementAccount = { ...account('6222000000004088'), fileName: 'statement.pdf', sourceDocumentId: 'doc-statement' };
  const first = {
    ...transaction('page-4-row', statementAccount.accountNumber, 'OUT', 4000, 6497.36, '收款人', '跨行汇款'),
    transactionTime: '2025-01-02 09:23:02', rawSourceFile: 'statement.pdf', sourceDocumentId: 'doc-statement',
    rawPageNumber: 4, rawRowIndex: 1
  };
  const reprint = {
    ...first, id: 'page-13-row', rawPageNumber: 13, rawRowIndex: 1,
    duplicateOfTransactionId: first.id, excludedFromAnalysis: true
  };

  const result = new LawFlowEngine().evaluateCase(metadata, [first, reprint], [statementAccount]);
  assert.equal(result.report.sourceObservationCount, 2);
  assert.equal(result.report.canonicalTransactionCount, 1);
  assert.equal(result.report.duplicateObservationCount, 1);
  assert.equal(result.report.totalRawOut, 4000);
  assert.equal(result.report.accountAudits?.[accountIdentityKey(statementAccount)]?.totalExpense, 4000);
  assert.equal(result.processedTransactions.length, 2);
  assert.equal(result.processedTransactions.filter(row => row.excludedFromAnalysis).length, 1);
});

test('same-day same-amount rows are not merged without another strong matching field', () => {
  const firstAccount = { ...account('6222000000004088'), fileName: 'first.pdf', sourceDocumentId: 'doc-first' };
  const secondAccount = { ...account('6222000000004088'), fileName: 'second.pdf', sourceDocumentId: 'doc-second' };
  const first = {
    ...transaction('first-row', firstAccount.accountNumber, 'OUT', 100, 900, '', ''),
    balanceAvailable: false, rawSourceFile: 'first.pdf', sourceDocumentId: 'doc-first'
  };
  const second = {
    ...first, id: 'second-row', rawSourceFile: 'second.pdf', sourceDocumentId: 'doc-second', rawText: '另一笔同额交易'
  };
  const report = new LawFlowEngine().evaluateCase(metadata, [first, second], [firstAccount, secondAccount]).report;
  assert.equal(report.canonicalTransactionCount, 2);
  assert.equal(report.totalRawOut, 200);
  assert.equal(report.analysisGraph?.duplicateGroups.length, 0);
});

test('name-only possible internal transfers stay in totals and are exposed as review candidates', () => {
  const accounts = [account('6222000000000001'), account('6222000000000002')];
  const rows = [
    transaction('out-name', accounts[0].accountNumber, 'OUT', 500, 500, '测试甲', '转账'),
    transaction('in-name', accounts[1].accountNumber, 'IN', 500, 500, '测试甲', '转账')
  ];
  const result = new LawFlowEngine().evaluateCase(metadata, rows, accounts).report;
  assert.equal(result.internalTransferCount, 0);
  assert.equal(result.internalTransferCandidates?.length, 1);
  assert.equal(result.netExternalIn, 500);
  assert.equal(result.netExternalOut, 500);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeTableMapping, type TableMappingPlan } from '../src/recognition/tableMapping';
import type { SourceRegistry } from '../src/recognition/sourceAssembly';
import { runQualityTrial } from '../src/recognition/qualityTrialPipeline';

function fixture(description: string, party: string) {
  const values = ['1234567890123456', '2026-01-02', 'OUT', '10.00', '90.00', description, party];
  const registry: SourceRegistry = { pages: [1], cells: Object.fromEntries(values.map((text, i) =>
    [i + 1, { id: i + 1, text, page: 1, row: 1, column: i + 1 }])),
    rows: { 1: { id: 1, page: 1, table: 1, row: 1, cells: values.map((_, i) => i + 1) } } };
  const mapping: TableMappingPlan = { tables: [{ page: 1, table: 1, kind: 'transactions', accountKind: 'deposit',
    fields: Object.fromEntries(['accountNumber', 'transactionDate', 'direction', 'amount', 'balance', 'description', 'counterpartyName']
      .map((key, i) => [key, { row: 0, col: i + 1 }])), directionCodes: null, groups: [[1]], ignored: [] }],
    typeRules: [{ accountKind: 'deposit', text: '网银支付收到轧差通知', type: '账户转账' }] };
  return { registry, mapping };
}

test('printed wrapping matches type rules while evidence text stays unchanged', () => {
  for (const description of ['网银支付\n收到轧差\n通知', '网银支付\\n收到轧差\\n通知']) {
    const { registry, mapping } = fixture(description, '测试单位');
    const result = materializeTableMapping(mapping, registry);
    assert.equal(result.rows[0].values[8], '账户转账');
    assert.equal(result.rows[0].fields[8][0].text, description);
    assert.equal(registry.cells[6].text, description);
  }
});

test('wrapped insurer name retains original spelling and supports the existing type rule', () => {
  const name = '示例财产保险股份\n有限公司';
  const { registry, mapping } = fixture('代扣', name);
  const result = runQualityTrial(mapping, registry, {}, { singleIssuerDocument: false });
  assert.equal(result.rows[0].values[8], '保险支出');
  assert.equal(result.rows[0].values[9], name);
});

test('different words are not collapsed into an unrelated type', () => {
  const { registry, mapping } = fixture('网银支付失败通知', '测试单位');
  assert.equal(materializeTableMapping(mapping, registry).rows[0].values[8], '');
});

test('an internal interest ledger is flagged when the issuing bank is unknown', () => {
  const { registry, mapping } = fixture('利息', '银行卡存款应计付利息0000');
  const result = runQualityTrial(mapping, registry, {}, { singleIssuerDocument: false });
  assert.ok(result.pending.some(issue => issue.code === 'SERVICE_ISSUER_UNCONFIRMED'
    && issue.field === 'counterpartyName' && issue.outputRows.includes(1)));
});

test('account-list groups stay source evidence and never become transaction rows', () => {
  const { registry, mapping } = fixture('账户信息', '测试单位');
  mapping.tables[0].kind = 'account';
  const result = materializeTableMapping(mapping, registry);
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.plan.ignored, [{ r: [1], kind: 'account' }]);
  assert.equal(registry.rows[1].cells.length, 7);
});

test('an explicitly labelled business type is considered alongside the free-text memo', () => {
  const { registry, mapping } = fixture('自由备注', '测试单位');
  registry.cells[8] = { id: 8, page: 1, row: 1, column: 8, text: '网银支付\n收到轧差通知' };
  registry.rows[1].cells.push(8);
  registry.cells[9] = { id: 9, page: 1, row: 2, column: 8, text: '交易类型' };
  registry.rows[2] = { id: 2, page: 1, table: 1, row: 2, cells: [0, 0, 0, 0, 0, 0, 0, 9] };
  registry.cells[0] = { id: 0, page: 1, row: 2, column: 1, text: '' };
  mapping.tables[0].ignored.push({ r: [2], kind: 'header' });
  const result = materializeTableMapping(mapping, registry);
  assert.equal(result.rows[0].values[8], '账户转账');
  assert.ok(result.rows[0].fields[8].some(field => field.id === 8));
  registry.cells[9].text = '备注';
  assert.equal(materializeTableMapping(mapping, registry).rows[0].values[8], '');
});

test('an explicit judicial deduction description resolves a generic transfer mechanism', () => {
  const { registry, mapping } = fixture('法院扣划', '示例法院');
  mapping.typeRules = [{ accountKind: 'deposit', text: '法院扣划', type: '账户转账' }];
  const result = runQualityTrial(mapping, registry, {}, { singleIssuerDocument: false });
  assert.equal(result.rows[0].values[8], '司法扣划');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSourceParty } from '../src/recognition/sourceFragments';
import { printedTransactionType } from '../src/recognition/printedTransactionType';
import { runQualityTrial } from '../src/recognition/qualityTrialPipeline';
import type { TableMappingPlan } from '../src/recognition/tableMapping';
import type { SourceRegistry } from '../src/recognition/sourceAssembly';
import { KEY_READER_COLUMNS, type IndependentPage } from '../src/recognition/independentComparison';

test('combined party fragments keep masking/leading zeros and reject competing identities', () => {
  const cell = { id: 1, page: 1, row: 1, column: 1, text: '001234567890/测试户名' };
  assert.deepEqual(selectSourceParty(cell, 'account'), [{ id: 1, text: '001234567890' }]);
  assert.deepEqual(selectSourceParty(cell, 'name'), [{ id: 1, text: '测试户名' }]);
  assert.deepEqual(selectSourceParty({ ...cell, text: '001234567890' }, 'account'), [1]);
  assert.deepEqual(selectSourceParty({ ...cell, text: '001234567890' }, 'name'), []);
  assert.deepEqual(selectSourceParty({ ...cell, text: '测试户名\n0012****7890' }, 'account'), [{ id: 1, text: '0012****7890' }]);
  for (const text of ['001234567890/009876543210', '001234567890/甲/乙', '不详/某甲']) {
    assert.equal(selectSourceParty({ ...cell, text }, 'account'), null);
  }
});

function fixture() {
  const raw = [['日期', '交易金额', '余额', '摘要', '对方账号与户名', '附言'],
    ['2026-01-01', '-10.00', '90.00', '消费', '009876543210/测试商户', '信用卡还款'],
    ['2026-01-02', '20.00', '110.00', '消费退货', '009876543210/测试商户', '']];
  const registry: SourceRegistry = { cells: {}, rows: {}, pages: [1] };
  for (const [r, row] of raw.entries()) {
    const cells = row.map((text, c) => { const id = r * 6 + c + 1;
      registry.cells[id] = { id, page: 1, row: r + 1, column: c + 1, text }; return id; });
    registry.rows[r + 1] = { id: r + 1, page: 1, table: 1, row: r + 1, cells };
  }
  registry.cells[19] = { id: 19, page: 1, row: null, column: null, text: '001234567890' };
  const mapping: TableMappingPlan = { tables: [{ page: 1, table: 1, kind: 'transactions', accountKind: 'deposit',
    fields: { accountNumber: { fixed: 19 }, transactionDate: { row: 0, col: 1 }, amount: { row: 0, col: 2 },
      balance: { row: 0, col: 3 }, description: { row: 0, col: 4 }, counterpartyAccount: null, counterpartyName: null },
    directionCodes: null, ignored: [{ r: [1], kind: 'header' }], groups: [[2], [3]] }],
    typeRules: [{ accountKind: 'deposit', text: '消费', type: '消费' }, { accountKind: 'deposit', text: '消费退货', type: '消费' }] };
  const independent: Record<number, IndependentPage> = { 1: { pageType: 'transactions', coverage: 'complete', pageIssues: [],
    rows: raw.slice(1).map((r, i) => {
      const values = ['001234567890', '', '', '', r[0], i ? 'IN' : 'OUT', i ? '20.00' : '10.00', r[2], '', '测试商户', '009876543210', ''];
      return { row: i + 1, values: KEY_READER_COLUMNS.map(f => values[f]), rawDirection: i ? '' : '-', issues: [] };
    }) } };
  return { registry, mapping, independent };
}

test('full assembly recovers omitted combined columns, signed income, and purpose without changing source', () => {
  const { registry, mapping, independent } = fixture(); const before = JSON.stringify(registry);
  const result = runQualityTrial(mapping, registry, independent, { singleIssuerDocument: false });
  assert.deepEqual(result.rows.map(r => [r.values[3], r.values[5], r.values[8], r.values[10]]),
    [['', 'OUT', '信用卡还款', '009876543210'], ['', 'IN', '退款', '009876543210']]);
  assert.equal(result.pending.length, 0);
  assert.equal(JSON.stringify(registry), before);
});

test('unsigned-only and credit columns cannot establish income, conflicting independent direction stays visible', () => {
  for (const change of ['unsigned', 'credit', 'conflict', 'uncertain'] as const) {
    const { registry, mapping, independent } = fixture();
    if (change === 'unsigned') registry.cells[8].text = '10.00';
    if (change === 'credit') mapping.tables[0].accountKind = 'credit';
    if (change === 'conflict') independent[1].rows[1].values[3] = 'OUT';
    if (change === 'uncertain') independent[1].rows[1].issues.push({ field: 'direction', kind: 'unclear', reason: 'blurred sign' });
    const result = runQualityTrial(mapping, registry, independent, { singleIssuerDocument: false });
    assert.equal(result.rows[1].values[5], '', change);
    assert.ok(result.pending.some(i => i.field === 'direction' && i.outputRows.includes(2)), change);
  }
});

test('unreadable combined identity is reported even if both models leave the party blank', () => {
  const { registry, mapping, independent } = fixture(); registry.cells[11].text = '不详/某甲';
  independent[1].rows[0].values[6] = ''; independent[1].rows[0].values[7] = '';
  const result = runQualityTrial(mapping, registry, independent, { singleIssuerDocument: false });
  assert.ok(result.pending.some(i => i.code === 'AMBIGUOUS_PARTY_FRAGMENT' && i.field === 'counterpartyAccount'));
});

test('purpose rules distinguish explicit repayment, uncertain repayment, refunds, and payment channels', () => {
  const pick = (d: string, evidence: string[], dir = 'OUT', kind = 'deposit') => printedTransactionType(d, [d, ...evidence], dir, kind)?.type;
  assert.equal(pick('消费', ['支付宝-信用卡还款']), '信用卡还款');
  assert.equal(pick('跨行代收', ['贷款还款']), '贷款还款');
  assert.equal(pick('消费', ['支付宝-还款']), '消费');
  assert.equal(printedTransactionType('消费', ['消费', '支付宝-还款'], 'OUT', 'deposit')?.requiresReview, true);
  assert.equal(pick('消费', ['支付宝']), undefined);
  assert.equal(pick('跨行代收', ['信用卡还款', '贷款还款']), '');
  assert.equal(pick('消费退货', [], 'IN'), '退款');
  assert.equal(pick('网银转入', ['余额宝提现'], 'IN'), '第三方支付');
  assert.equal(pick('网上支付', []), '第三方支付');
  assert.equal(pick('网上支付', ['信用卡还款']), '信用卡还款');
  assert.equal(pick('示例银行存现', [], 'IN'), '现金存入');
  assert.equal(pick('示例银行取现', [], 'OUT', 'credit'), undefined);
});

test('uncertain repayment preserves an existing candidate type while adding a field-specific check', () => {
  const { registry, mapping, independent } = fixture();
  registry.cells[10].text = '批量还款'; registry.cells[12].text = '';
  mapping.typeRules = [{ accountKind: 'deposit', text: '批量还款', type: '贷款还款' }];
  const result = runQualityTrial(mapping, registry, independent, { singleIssuerDocument: false });
  assert.equal(result.rows[0].values[8], '贷款还款');
  assert.ok(result.pending.some(i => i.code === 'REPAYMENT_KIND_UNRESOLVED' && i.field === 'transactionType' && i.outputRows.includes(1)));
});

test('financial institution income cannot be classified from a payment channel alone', () => {
  for (const description of ['银联入账', '贷款放款']) {
    const { registry, mapping, independent } = fixture();
    registry.cells[16].text = description;
    registry.cells[17].text = '009876543210/示例信托股份有限公司';
    independent[1].rows[1].values[6] = '示例信托股份有限公司';
    const result = runQualityTrial(mapping, registry, independent, { singleIssuerDocument: false });
    assert.equal(result.rows[1].values[8], description === '银联入账' ? '' : '贷款放款');
    assert.equal(result.pending.some(i => i.code === 'FINANCIAL_INCOME_PURPOSE_UNRESOLVED' && i.outputRows.includes(2)), description === '银联入账');
  }
});

test('an existing type cannot silence missing party evidence on a cash transaction', () => {
  const { registry, mapping, independent } = fixture();
  registry.cells[10].text = '现金支取'; registry.cells[11].text = ''; registry.cells[12].text = '';
  mapping.tables[0].fields.counterpartyAccount = null; mapping.tables[0].fields.counterpartyName = null;
  // A combined column that was not selected is different from explicit empty party cells.
  registry.cells[5].text = '未标明字段';
  independent[1].rows[0].values[6] = ''; independent[1].rows[0].values[7] = '';
  const result = runQualityTrial(mapping, registry, independent, { singleIssuerDocument: false });
  assert.equal(result.rows[0].values[8], '现金支取');
  assert.ok(result.pending.some(i => i.code === 'COUNTERPARTY_IDENTITY_MISSING' && i.outputRows.includes(1)));
});

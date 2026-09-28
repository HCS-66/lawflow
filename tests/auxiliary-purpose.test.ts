import test from 'node:test';
import assert from 'node:assert/strict';
import { auxiliaryPrintedPurpose } from '../src/recognition/auxiliaryPurpose';
import { buildQualitySources } from '../src/recognition/qualitySources';
import type { MappedTable } from '../src/recognition/tableMapping';
import type { AssembledRow } from '../src/recognition/sourceAssembly';
const table: MappedTable = { page: 1, table: 1, kind: 'transactions', accountKind: 'deposit', fields: {}, directionCodes: null,
  groups: [[2]], ignored: [{ r: [1], kind: 'header' }] };
function fixture(text: string, direction = 'IN', header = '商户名称') {
  const { registry } = buildQualitySources([{ nearTableText: [], tables: [{ rows: [[header], [text]] }] }]);
  const row: AssembledRow = { id: 'R1', values: Array(12).fill(''), fields: Array.from({ length: 12 }, () => []), sourceRows: [2] };
  row.values[5] = direction; return { registry, row };
}
test('literal business labels in auxiliary cells retain their printed source', () => {
  for (const [label, direction, type] of [['代发工资', 'IN', '工资收入'], ['银联入账', 'IN', '第三方支付'], ['转账支出', 'OUT', '账户转账']]) {
    const { row, registry } = fixture(label, direction); const recovered = auxiliaryPrintedPurpose(row, table, registry);
    assert.equal(recovered?.type, type); assert.equal(recovered?.cell.text, label);
  }
});
test('merchant substrings, wrong direction, other columns and established types are not overwritten', () => {
  for (const [label, direction, header] of [['代发工资便利店', 'IN', '商户名称'], ['代发工资', 'OUT', '商户名称'], ['银联入账', 'IN', '对方名称']]) {
    const { row, registry } = fixture(label, direction, header); assert.equal(auxiliaryPrintedPurpose(row, table, registry), null);
  }
  const { row, registry } = fixture('银联入账'); row.values[8] = '贷款放款';
  assert.equal(auxiliaryPrintedPurpose(row, table, registry), null);
});
test('explicit payment-provider purchase labels in a location column retain their exact source', () => {
  for (const [label, header] of [['支付宝-消费', '交易地点'], ['微信—消费', '交易地点 Trading Place']]) {
    const { row, registry } = fixture(label, 'OUT', header);
    assert.equal(auxiliaryPrintedPurpose(row, table, registry)?.type, '消费');
  }
  for (const [label, direction, header] of [['支付宝-消费百货店', 'OUT', '交易地点'], ['支付宝-消费', 'IN', '交易地点'], ['支付宝-消费', 'OUT', '对方名称']]) {
    const { row, registry } = fixture(label, direction, header);
    assert.equal(auxiliaryPrintedPurpose(row, table, registry), null);
  }
});

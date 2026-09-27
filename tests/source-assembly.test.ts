import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFromSource, moneyFromSource, dateFromSource, assembleFromSources,
  type AssemblyPlan, type SourceRegistry } from '../src/recognition/sourceAssembly';

test('source money is exact, preserves signed balance and rejects malformed or invented decimals', () => {
  assert.equal(moneyFromSource('-1,234.50'), '-1234.50');
  assert.equal(moneyFromSource('-1,234.50', true), '1234.50');
  assert.equal(moneyFromSource('9007199254740993.01'), '9007199254740993.01');
  assert.equal(moneyFromSource('1,23.45'), null);
  assert.equal(moneyFromSource('12.345'), null);
  assert.equal(moneyFromSource(''), '');
});

test('identities preserve leading zeros and do not choose between an ID and account', () => {
  assert.equal(accountFromSource('001234567890'), '001234567890');
  assert.equal(accountFromSource('身份证 510000200001010011 账号 6222000000001234'), null);
  assert.equal(dateFromSource('2026-07-'), null);
  assert.equal(dateFromSource('2026-02-29'), null);
  assert.equal(dateFromSource('20240229121212'), '2024-02-29');
});

function fixture(): { registry: SourceRegistry; plan: AssemblyPlan } {
  const text = ['001234567890', '2024-01-01', '-10.00', '100.00', '账户转账', '某甲', '6222000000001234', '110.00'];
  const cells = Object.fromEntries(text.map((t, n) => [n + 1, { id: n + 1, text: t, page: 1, row: n === 7 ? 2 : 1, column: n + 1 }]));
  return { registry: { pages: [1], cells, rows: { 1: { id: 1, page: 1, table: 1, row: 1, cells: [1, 2, 3, 4, 5, 6, 7] },
    2: { id: 2, page: 1, table: 1, row: 2, cells: [8] } } },
    plan: { rows: [{ r: [1, 2], f: [[1], [], [], [2], [2], [3], [3], [4, 8], [5], [6], [7], []], d: 'OUT', t: '账户转账' }], ignored: [] } };
}

test('a selected correct source cannot silence a contradictory alternative balance', () => {
  const { plan, registry } = fixture();
  const result = assembleFromSources(plan, registry);
  assert.equal(result.rows[0].values[6], '10.00');
  assert.equal(result.rows[0].values[7], '100.00');
  assert.ok(result.issues.some(i => i.code === 'SOURCE_VALUE_CONFLICT' && i.field === 'balance'));
});

test('a generated account fragment is rejected rather than copied to the result', () => {
  const { plan, registry } = fixture();
  plan.rows[0].f[10] = [{ id: 7, text: '6222000000009999' }];
  const result = assembleFromSources(plan, registry);
  assert.equal(result.rows[0].values[10], '');
  assert.ok(result.issues.some(i => i.code === 'INVALID_SOURCE_FRAGMENT'));
});

test('omitted source rows and duplicate source usage prevent complete status', () => {
  const { plan, registry } = fixture();
  plan.rows[0].r = [1];
  assert.equal(assembleFromSources(plan, registry).complete, false);
  plan.rows.push(structuredClone(plan.rows[0]));
  assert.ok(assembleFromSources(plan, registry).issues.some(i => i.code === 'SOURCE_ROW_REUSED'));
});

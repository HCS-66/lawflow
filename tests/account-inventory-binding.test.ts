import test from 'node:test';
import assert from 'node:assert/strict';
import { bindAccountInventory, assessAccountInventory } from '../src/recognition/accountInventoryBinding';
import type { AssembledRow, SourceRegistry } from '../src/recognition/sourceAssembly';
import type { TableMappingPlan } from '../src/recognition/tableMapping';
import type { IndependentPage } from '../src/recognition/independentComparison';

function fixture() {
  const cells = ['账号', '客户名称', '金额', '数据日期', '2200123456789012', '某甲', '103.00', '20260131'];
  const registry: SourceRegistry = { pages: [1, 2], cells: Object.fromEntries(cells.map((text, i) =>
    [i + 1, { id: i + 1, text, page: 1, row: i < 4 ? 1 : 2, column: i % 4 + 1 }])),
    rows: { 1: { id: 1, page: 1, table: 1, row: 1, cells: [1, 2, 3, 4] },
      2: { id: 2, page: 1, table: 1, row: 2, cells: [5, 6, 7, 8] },
      3: { id: 3, page: 2, table: 1, row: 1, cells: [] }, 4: { id: 4, page: 2, table: 1, row: 2, cells: [] } } };
  const rows: AssembledRow[] = [1, 2].map(n => ({ id: `T${n}`, sourceRows: [n + 2], fields: Array.from({ length: 12 }, () => []),
    values: ['00123456789012', '某甲', '', '', `2026-01-0${n}`, 'IN', '1.00', `${101 + n}.00`, '', '', '', ''] }));
  const mapping: TableMappingPlan = { typeRules: [], tables: [{ page: 1, table: 1, kind: 'account', accountKind: 'deposit',
    fields: {}, directionCodes: null, groups: [], ignored: [{ r: [1], kind: 'header' }, { r: [2], kind: 'account' }] }] };
  const independent: Record<number, IndependentPage> = {
    1: { pageType: 'account_info', coverage: 'complete', pageIssues: [], rows: [], ownerIdentifiers: [{ role: 'account', value: '2200123456789012' }] },
    2: { pageType: 'transactions', coverage: 'complete', pageIssues: [], rows: rows.map((r, n) => ({ row: n + 1,
      values: [r.values[0], r.values[4], '', 'IN', r.values[6], r.values[7], '', ''], rawDirection: '', issues: [] })) }
  };
  return { rows, mapping, registry, independent };
}

test('local account binding requires a unique full account, matching owner and closing balance', () => {
  const f = fixture();
  assert.equal(bindAccountInventory(f.rows, f.mapping, f.registry, f.independent)[0].to, '2200123456789012');
  assert.equal(f.rows[0].values[0], '00123456789012', 'binding planner cannot mutate original evidence');
  f.registry.cells[7].text = '102.00';
  assert.deepEqual(bindAccountInventory(f.rows, f.mapping, f.registry, f.independent), []);
});

test('a plausible suffix alone cannot restore an account', () => {
  const f = fixture();
  f.independent[1].ownerIdentifiers = [];
  assert.deepEqual(bindAccountInventory(f.rows, f.mapping, f.registry, f.independent), []);
  const assessment = assessAccountInventory(f.rows, f.mapping, f.registry, f.independent);
  assert.equal(assessment.unresolved.length, 1);
  assert.deepEqual(assessment.unresolved[0].observations, [1, 2], 'unconfirmed account scope includes every affected row');
});

test('a separate full-page read can corroborate a printed account-list entry without supplying the expected value', () => {
  const f = fixture(); f.independent[1].ownerIdentifiers = [{ role: 'account', value: '2200123456789022' }];
  const focused = { 1: { bankName: '', issues: [], identifiers: [{ role: 'account' as const,
    scope: 'account_information' as const, table: 1, label: '账号', value: '2200123456789012',
    characters: [...'2200123456789012'], uncertainPositions: [] as number[] }] } };
  const result = assessAccountInventory(f.rows, f.mapping, f.registry, f.independent, focused);
  assert.equal(result.bindings.length, 1); assert.equal(result.unresolved.length, 0);
  focused[1].identifiers[0].uncertainPositions = [3];
  assert.equal(assessAccountInventory(f.rows, f.mapping, f.registry, f.independent, focused).bindings.length, 0);
});

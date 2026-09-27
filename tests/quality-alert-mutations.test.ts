import test from 'node:test';
import assert from 'node:assert/strict';
import { compareIndependentReadings, KEY_READER_COLUMNS, type IndependentPage } from '../src/recognition/independentComparison';
import { STATEMENT_COLUMNS, type AssembledRow, type SourceRegistry } from '../src/recognition/sourceAssembly';
import { findUnmergedViewOverlaps } from '../src/recognition/unmergedViews';

function fixture() {
  const rows: AssembledRow[] = Array.from({ length: 5 }, (_, n) => ({ id: `T${n + 1}`, sourceRows: [n + 1],
    fields: Array.from({ length: 12 }, () => []), values: ['001234567890', '某甲', '示例银行', '', `2026-01-0${n + 1}`,
      'OUT', `${n + 1}.00`, `${100 - n}.00`, '账户转账', '某乙', '009876543210', ''] }));
  const registry: SourceRegistry = { cells: {}, pages: [1], rows: Object.fromEntries(rows.map((_, n) =>
    [n + 1, { id: n + 1, page: 1, table: 1, row: n + 1, cells: [] }])) };
  const pages: Record<number, IndependentPage> = { 1: { pageType: 'transactions', coverage: 'complete', pageIssues: [],
    rows: rows.map((r, n) => ({ row: n + 1, rawDirection: 'OUT', issues: [], values: KEY_READER_COLUMNS.map(f => r.values[f]) })) } };
  return { rows, registry, pages };
}

test('single critical-field corruption is located to the specific row and field, without shifting following rows', () => {
  for (const [field, value] of [[0, '001234567891'], [4, '2025-01-03'], [5, 'IN'], [6, '30.00'], [7, '980.00'], [10, '009876543211']] as const) {
    const { rows, registry, pages } = fixture(); rows[2].values[field] = value;
    const result = compareIndependentReadings(rows, registry, pages);
    const conflicts = result.issues.filter(i => i.code === 'INDEPENDENT_VALUE_CONFLICT');
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].field, STATEMENT_COLUMNS[field]);
    assert.deepEqual(conflicts[0].outputRows, [3]);
    assert.deepEqual(conflicts[0].sourceRows, [3]);
    assert.equal(result.pairs.length, 5);
  }
});

test('an independently observed missing transaction creates a source-located coverage issue', () => {
  const { rows, registry, pages } = fixture(); rows.splice(2, 1);
  const issues = compareIndependentReadings(rows, registry, pages).issues;
  const missing = issues.find(i => i.code === 'INDEPENDENT_EXTRA_OBSERVATION');
  assert.ok(missing); assert.ok(missing.sourceRows.includes(3));
});

test('partial duplicate-view overlap is not silently accepted when cash fields prevent complete merging', () => {
  const { rows } = fixture();
  const copy = structuredClone(rows); copy[3].values[6] = '999.00'; copy[4].values[7] = '777.00';
  const all = [...rows, ...copy];
  const context = all.map((_, n) => ({ page: n < 5 ? 1 : 2, table: 1, order: n % 5 + 1,
    directOwner: n >= 5, accountKind: 'deposit', description: '' }));
  const events = new Map(all.map((_, n) => [n + 1, n + 1]));
  assert.equal(findUnmergedViewOverlaps(all, context, events).length, 1);
});

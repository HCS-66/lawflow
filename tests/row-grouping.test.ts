import test from 'node:test';
import assert from 'node:assert/strict';
import { repairUniformRowGroups } from '../src/recognition/rowGrouping';
import type { SourceRegistry } from '../src/recognition/sourceAssembly';
import type { MappedTable } from '../src/recognition/tableMapping';

test('printed two-line boundaries repair reused rows but never move a genuinely different column override', () => {
  const values = [['2026-01-01', '+1.00'], ['1234567890', '某甲'], ['2026-01-02', '-2.00'], ['1234567891', '某乙']];
  const registry: SourceRegistry = { pages: [1], cells: {}, rows: {} };
  values.forEach((v, i) => {
    registry.rows[i + 1] = { id: i + 1, page: 1, table: 1, row: i + 1, cells: v.map((text, col) => {
      const id = i * 2 + col + 1; registry.cells[id] = { id, page: 1, row: i + 1, column: col + 1, text }; return id;
    }) };
  });
  const table: MappedTable = { page: 1, table: 1, kind: 'transactions', accountKind: 'deposit', directionCodes: null,
    groups: [[1, 2], [2, 3]], ignored: [], fields: { transactionDate: { row: 0, col: 1 }, amount: { row: 0, col: 2 } },
    overrides: [{ firstRow: 2, fields: { transactionDate: { row: 1, col: 1 }, amount: { row: 1, col: 2 } } }] };
  assert.deepEqual(repairUniformRowGroups(table, registry)?.groups, [[1, 2], [3, 4]]);
  assert.deepEqual(repairUniformRowGroups(table, registry)?.overrides, []);
  table.overrides![0].fields.amount = { row: 1, col: 1 };
  assert.equal(repairUniformRowGroups(table, registry), null);
});

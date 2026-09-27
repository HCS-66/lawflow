import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverDescriptionColumn } from '../src/recognition/columnRecovery';
import type { SourceRegistry } from '../src/recognition/sourceAssembly';
import type { MappedTable } from '../src/recognition/tableMapping';

test('detached summary header is used only with one otherwise-unlabelled column on every transaction', () => {
  const registry: SourceRegistry = { pages: [1], cells: {
    1: { id: 1, text: '日期', page: 1, row: 1, column: 1 },
    2: { id: 2, text: '2026-01-01', page: 1, row: 2, column: 1 },
    3: { id: 3, text: '存款结息', page: 1, row: 2, column: 2 },
    4: { id: 4, text: '交易摘要', page: 1, row: null, column: null }
  }, rows: { 1: { id: 1, page: 1, table: 1, row: 1, cells: [1] }, 2: { id: 2, page: 1, table: 1, row: 2, cells: [2, 3] } } };
  const table: MappedTable = { page: 1, table: 1, kind: 'transactions', accountKind: 'deposit', fields: { description: null },
    groups: [[2]], ignored: [{ r: [1], kind: 'header' }], directionCodes: null };
  assert.deepEqual(recoverDescriptionColumn(table, registry)?.selector, { row: 0, col: 2 });
  registry.rows[2].cells.push(3);
  assert.equal(recoverDescriptionColumn(table, registry), null, 'two extra columns are ambiguous');
  registry.rows[2].cells.pop(); registry.cells[4].text = '其他内容';
  assert.equal(recoverDescriptionColumn(table, registry), null, 'values alone cannot identify a missing label');
});

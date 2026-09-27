import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverPrintedOwnerPrefixes } from '../src/recognition/printedOwnerPrefixes';
import type { AssembledRow, SourceRegistry } from '../src/recognition/sourceAssembly';
import type { IndependentPage } from '../src/recognition/independentComparison';

test('clipped own account requires a full printed header and separate corroboration; a prefix alone cannot fill it', () => {
  const number = '1234567800000001';
  const rows: AssembledRow[] = ['12345678', number].map((account, i) => ({ id: `T${i}`, sourceRows: [i + 1],
    values: [account, ...Array(11).fill('')], fields: Array.from({ length: 12 }, () => []) }));
  const context = rows.map((_, i) => ({ page: i + 1, table: 1, order: 1, directOwner: true, accountKind: 'credit', description: '' }));
  const registry: SourceRegistry = { pages: [1, 2, 3], rows: {}, cells: { 1: { id: 1, page: 1, row: null, column: null, text: number } } };
  const info: IndependentPage = { pageType: 'account_info', coverage: 'complete', rows: [], pageIssues: [], ownerIdentifiers: [{ role: 'card', value: number }] };
  assert.equal(recoverPrintedOwnerPrefixes(rows, context, registry, {}).length, 0);
  assert.equal(recoverPrintedOwnerPrefixes(rows, context, registry, { 3: info })[0].value, number);
  registry.cells[2] = { ...registry.cells[1], id: 2, text: '1234567800000002' };
  assert.equal(recoverPrintedOwnerPrefixes(rows, context, registry, { 3: info }).length, 0);
  assert.equal(rows[0].values[0], '12345678', 'recovery plan retains raw transcription');
});

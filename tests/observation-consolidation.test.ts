import test from 'node:test';
import assert from 'node:assert/strict';
import { consolidateObservations, type ObservationContext } from '../src/recognition/observationConsolidation';
import type { AssembledRow } from '../src/recognition/sourceAssembly';
const row = (n: number, owner: string): AssembledRow => ({ id: `r${n}-${owner}`, sourceRows: [n], fields: Array.from({ length: 12 }, () => []),
  values: [owner, '', '', '', `2026-01-${String(n).padStart(2, '0')}`, 'OUT', `${n}.00`, `${100 - n}.00`, '', '', '6222000000000001', ''] });
const meta = (directOwner: boolean): ObservationContext => ({ page: directOwner ? 2 : 1, table: 1, order: 1, directOwner, accountKind: 'deposit', description: '' });
test('established duplicate views merge without erasing conflicting account observations', () => {
  const rows = [1, 2, 3].map(n => row(n, '001234567891')).concat([1, 2, 3].map(n => row(n, '001234567890')));
  const result = consolidateObservations(rows, [meta(false), meta(false), meta(false), meta(true), meta(true), meta(true)]);
  assert.equal(result.events.length, 3);
  assert.equal(result.events[0].values[0], '001234567890');
  assert.equal(result.events[0].conflicts[0].field, 0);
});
test('same-day identical transactions in the same stream are retained separately', () => {
  const rows = [row(1, '001234567890'), row(1, '001234567890')];
  assert.equal(consolidateObservations(rows, [meta(true), meta(true)]).events.length, 2);
});
test('one accidental matching transaction does not establish duplicate statement views', () => {
  const rows = [row(1, '001234567891'), row(1, '001234567890')];
  assert.equal(consolidateObservations(rows, [meta(false), meta(true)]).events.length, 2);
});

test('independent positions can link a damaged duplicate only inside already established views', () => {
  const rows = [1, 2, 3, 4, 5].map(n => row(n, '001234567890')).concat([1, 2, 3, 4, 5].map(n => row(n, '001234567890')));
  const context = [...Array.from({ length: 5 }, () => meta(false)), ...Array.from({ length: 5 }, () => meta(true))];
  const readings = Object.fromEntries(rows.map((r, i) => [i + 1, [...r.values]]));
  rows[0].values[4] = '2025-01-01'; rows[0].values[6] = '999.00'; rows[0].values[7] = '888.00';
  const original = structuredClone(rows);
  assert.equal(consolidateObservations(rows, context).events.length, 6);
  const assisted = consolidateObservations(rows, context, readings);
  assert.equal(assisted.events.length, 5);
  assert.ok(assisted.events[0].conflicts.some(c => c.field === 6));
  assert.deepEqual(rows, original, 'linking cannot overwrite primary evidence');
  readings[1][4] = '2025-01-01'; readings[1][6] = '999.00'; readings[1][7] = '888.00';
  assert.equal(consolidateObservations(rows, context, readings).events.length, 6);
});

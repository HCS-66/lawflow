import test from 'node:test';
import assert from 'node:assert/strict';
import { alignIndependentRows } from '../src/recognition/independentComparison';
const row = (n: number) => ['001234567890', '', '', '', `2026-01-${String(n).padStart(2, '0')}`, 'OUT', `${n}.00`, `${100 - n}.00`, '', '', '6222000000000001', ''];
test('one missing row does not shift all subsequent field comparisons', () => {
  const result = alignIndependentRows([row(1), row(2), row(3)], [row(1), row(3)]);
  assert.deepEqual(result.pairs, [{ left: 0, right: 0 }, { left: 2, right: 1 }]);
  assert.deepEqual(result.unmatchedLeft, [1]);
});
test('a changed account digit does not prevent alignment by other independent content', () => {
  const other = row(1); other[10] = '6222000000000002';
  assert.deepEqual(alignIndependentRows([row(1)], [other]).pairs, [{ left: 0, right: 0 }]);
});
test('ambiguous identical observations with a missing copy are not forcibly paired', () => {
  const result = alignIndependentRows([row(1), row(1)], [row(1)]);
  assert.equal(result.pairs.length, 0);
  assert.deepEqual(result.unmatchedLeft, [0, 1]);
});

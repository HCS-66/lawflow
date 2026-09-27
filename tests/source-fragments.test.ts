import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrintedNumberSpacing, selectSourceLine } from '../src/recognition/sourceFragments';
test('merged physical lines can be addressed without moving a counterparty into the amount', () => {
  const cell = { id: 1, page: 1, row: 1, column: 1, text: '-307. 24\\n某甲' };
  assert.deepEqual(selectSourceLine(cell, 0), [{ id: 1, text: '-307. 24', line: 0 }]);
  assert.deepEqual(selectSourceLine(cell, 1), [{ id: 1, text: '某甲', line: 1 }]);
  assert.equal(normalizePrintedNumberSpacing('-307. 24'), '-307.24');
  assert.equal(normalizePrintedNumberSpacing('100.00\n200.00'), '100.00\n200.00');
  assert.deepEqual(selectSourceLine(cell, 3), []);
});

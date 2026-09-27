import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityDeliveryStatus, withAnalysisTypeChecks } from '../src/review/qualityDelivery';
import type { QualityDeliveryInput } from '../src/review/qualityDelivery';
const input = (): QualityDeliveryInput => ({ complete: true, rows: [{ id: 'E1', values: Array(12).fill(''), sourceObservationIds: ['source:1'] }],
  pending: [{ id: 'I1', code: 'CONFLICT', field: 'counterpartyAccount', outputRows: [1], sourceRows: [1], sourceCells: [], severity: 'REQUIRED', message: 'Account differs' }] });
test('unresolved review cannot be exported as a final result', () => {
  const value = input();
  assert.equal(qualityDeliveryStatus(value).canExportAsFinal, false);
  const decision = { issueId: 'I1', status: 'UNRESOLVED' as const, reviewer: 'reviewer', reviewedAt: '2026-09-27', note: 'Still unreadable' };
  assert.equal(qualityDeliveryStatus(value, [decision]).canExportAsFinal, false);
  assert.equal(qualityDeliveryStatus(value, [{ ...decision, status: 'CONFIRMED' }]).canExportAsFinal, true);
  assert.equal(qualityDeliveryStatus({ ...value, complete: false }, [{ ...decision, status: 'CONFIRMED' }]).canExportAsFinal, false);
});
test('reviewing the account does not silently confirm an unknown transaction type', () => {
  const value = withAnalysisTypeChecks(input(), { cells: {}, pages: [1], rows: { 1: { id: 1, page: 1, table: 1, row: 1, cells: [] } } });
  assert.equal(value.pending.length, 2);
  const state = qualityDeliveryStatus(value, [{ issueId: 'I1', status: 'CONFIRMED', reviewer: 'reviewer', reviewedAt: '2026-09-27', note: '' }]);
  assert.equal(state.requiredRowCount, 1);
  assert.equal(state.pending[0].field, 'transactionType');
});

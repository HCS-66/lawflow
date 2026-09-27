import test from 'node:test';
import assert from 'node:assert/strict';
import { enforcementTruthProfile } from '../src/recognition/acceptanceProfile';
import { evaluateProductAcceptance, type QualityTruthRow } from '../src/recognition/acceptanceEvaluation';
const protocol = { kind: 'REGRESSION' as const, annotationsComplete: true, sourceAlignmentVerified: false, predictionsFrozenBeforeEvaluation: true, processingComplete: true };
const row: QualityTruthRow = { id: 'T1', values: ['001234567890', '某甲', '银行', '2026-01-01', '2026-01-01', 'OUT', '10.00', '90.00', '缴费', '某商户', '6222000000000001', ''], sourceObservationIds: ['source:1'] };
test('enforcement profile treats payment and purchase as ordinary expenditure but preserves seizure distinction', () => {
  const gold = enforcementTruthProfile(row);
  const actual = structuredClone(row); actual.values[8] = '消费';
  assert.equal(evaluateProductAcceptance([gold], [actual], [{ expectedId: 'T1', actualId: 'T1' }], [], protocol).correctRows, 1);
  actual.values[8] = '司法扣划';
  const score = evaluateProductAcceptance([gold], [actual], [{ expectedId: 'T1', actualId: 'T1' }], [], protocol);
  assert.equal(score.correctRows, 0);
  assert.equal(score.errors[0].field, 'transactionType');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProductAcceptance, type QualityRow, type QualityAlert, type AcceptanceProtocol } from '../src/recognition/acceptanceEvaluation';

const row = (n: number): QualityRow => ({ id: `t${n}`, sourceObservationIds: [`p1r${n}`],
  values: ['001234567890', '某乙', '银行', '2026-01-01', '2026-01-01', 'OUT', '10.00', '100.00', '消费', '某甲', '6222000000000001', ''] });
const protocol: AcceptanceProtocol = { kind: 'BLIND', annotationsComplete: true, sourceAlignmentVerified: true,
  predictionsFrozenBeforeEvaluation: true, processingComplete: true };
const align = (rows: QualityRow[]) => rows.map(r => ({ expectedId: r.id, actualId: r.id }));

test('all three gates hold together; wrong account must be specifically and correctly located', () => {
  const gold = Array.from({ length: 1000 }, (_, n) => row(n));
  const actual = structuredClone(gold); actual[0].values[10] = '6222000000000002';
  const alert: QualityAlert = { id: 'a', rowIds: ['t0'], sourceObservationIds: ['p1r0'], fields: ['counterpartyAccount'], reason: '两处账号数字不同', required: true };
  const good = evaluateProductAcceptance(gold, actual, align(gold), [alert], protocol);
  assert.equal(good.initialCriticalAccuracy, .999);
  assert.equal(good.manualReviewRate, .001);
  assert.equal(good.blindAcceptancePassed, true);
  const vague = evaluateProductAcceptance(gold, actual, align(gold), [{ ...alert, fields: ['ROW'] }], protocol);
  assert.equal(vague.unalertedCriticalErrorCount, 1);
  assert.equal(vague.blindAcceptancePassed, false);
  const wrongLocation = evaluateProductAcceptance(gold, actual, align(gold), [{ ...alert, sourceObservationIds: ['p2r1'] }], protocol);
  assert.equal(wrongLocation.unalertedCriticalErrorCount, 1);
});

test('whole-page review counts all affected transactions and duplicate alerts count once', () => {
  const gold = Array.from({ length: 100 }, (_, n) => row(n));
  const alert: QualityAlert = { id: 'page', rowIds: [], sourceObservationIds: gold.slice(0, 6).flatMap(r => r.sourceObservationIds), fields: ['ROW'], reason: '需检查本页交易行数', required: true };
  const result = evaluateProductAcceptance(gold, gold, align(gold), [alert, { ...alert, id: 'again' }], protocol);
  assert.equal(result.manualRows, 6);
  assert.equal(result.blindAcceptancePassed, false);
});

test('missing and extra transactions remain in accuracy and error denominators', () => {
  const gold = Array.from({ length: 10 }, (_, n) => row(n));
  const output = [...gold.slice(0, 9), row(100)];
  const result = evaluateProductAcceptance(gold, output, align(gold.slice(0, 9)), [], protocol);
  assert.equal(result.initialCriticalAccuracy, .9);
  assert.equal(result.unalertedCriticalErrorCount, 2);
  assert.ok(result.errors.some(e => e.kind === 'MISSING_ROW'));
  assert.ok(result.errors.some(e => e.kind === 'EXTRA_ROW'));
});

test('regression or unverified alignment cannot be labelled as blind acceptance', () => {
  const gold = [row(0)];
  const result = evaluateProductAcceptance(gold, gold, align(gold), [], { ...protocol, kind: 'REGRESSION', sourceAlignmentVerified: false });
  assert.equal(result.meetsObservedThresholds, true);
  assert.equal(result.blindAcceptancePassed, false);
  assert.equal(result.detectionRate, null);
});

test('missing counterparty account makes the identity name critical', () => {
  const gold = [row(0)]; gold[0].values[10] = '';
  const actual = structuredClone(gold); actual[0].values[9] = '另一个人';
  const result = evaluateProductAcceptance(gold, actual, align(gold), [], protocol);
  assert.equal(result.errors[0].field, 'counterpartyName');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRecognition, type RecognitionGroundTruth } from '../src/recognition/evaluation';
import type { StandardTransaction } from '../src/types/transaction';

const truth = (): RecognitionGroundTruth => ({
  version: 1, status: 'SOURCE_CHECKED', reviewedBy: '测试核对人',
  documents: [{ documentId: 'DOC_TEST', completePages: [1, 2], rows: [
    { page: 1, row: 1, fields: { accountNumber: '90000001', amount: 10, direction: 'IN' } }
  ] }]
});
const row = (): StandardTransaction => ({
  id: 'one', sourceDocumentId: 'DOC_TEST', accountNumber: '90000001', accountName: '测试', bankName: '待核验银行',
  transactionTime: '2024-01-01', transactionDate: '2024-01-01', direction: 'IN', amount: 10, balance: 100,
  counterpartyName: '', summary: '', rawSourceFile: 'A.pdf', rawPageNumber: 1, rawRowIndex: 1
});

test('evaluation measures fields and rejects duplicate or unexpected observations even when totals match', () => {
  const correct = evaluateRecognition([row()], truth());
  assert.equal(correct.passed, true);
  assert.equal(correct.fieldAccuracy, 1);
  const wrong = evaluateRecognition([{ ...row(), accountNumber: '90000002' }], truth());
  assert.equal(wrong.wrongAccounts, 1);
  assert.equal(wrong.passed, false);
  assert.equal(wrong.exactRowRecall, 0);
  assert.equal(evaluateRecognition([row(), { ...row(), id: 'duplicate' }], truth()).passed, false);
  assert.equal(evaluateRecognition([row(), { ...row(), rawPageNumber: 2 }], truth()).passed, false);
});

test('evaluation requires manual truth and ignores unannotated pages rather than crediting them', () => {
  assert.throws(() => evaluateRecognition([row()], { ...truth(), status: 'DRAFT' } as unknown as RecognitionGroundTruth));
  const evaluated = evaluateRecognition([row(), { ...row(), rawPageNumber: 3 }], truth());
  assert.equal(evaluated.predictedRows, 1);
  assert.equal(evaluated.expectedRows, 1);
  assert.equal(evaluated.passed, true);
});

test('counterparty account errors count even when all cash figures balance', () => {
  const labelled = truth();
  labelled.documents[0].rows[0].fields.counterpartyAccount = '6222000000000011';
  const result = evaluateRecognition([{ ...row(), counterpartyAccount: '6222000000000012' }], labelled);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(error => error.field === 'counterpartyAccount'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCriticalFieldRecovery, planCriticalFieldRecovery } from '../src/recognition/criticalFieldRecovery';
import { KEY_READER_COLUMNS, type IndependentPage } from '../src/recognition/independentComparison';
import type { AssembledRow, SourceRegistry, AssemblyIssue } from '../src/recognition/sourceAssembly';

function fixture() {
  const values = ['001234567890', '', '', '', '2026-02-01', 'OUT', '10.00', '90.00', '消费', '测试商户', '009876543210', ''];
  const registry: SourceRegistry = { pages: [1], rows: { 1: { id: 1, page: 1, table: 1, row: 1, cells: values.map((_, i) => i + 1) } },
    cells: Object.fromEntries(values.map((text, i) => [i + 1, { id: i + 1, text, page: 1, row: 1, column: i + 1 }])) };
  const rows: AssembledRow[] = [{ id: 'T1', values, sourceRows: [1],
    fields: values.map((text, i) => [{ id: i + 1, text, normalized: text }]) }];
  const page: IndependentPage = { pageType: 'transactions', coverage: 'complete', pageIssues: [],
    rows: [{ row: 1, values: KEY_READER_COLUMNS.map(f => values[f]), rawDirection: '-', issues: [] }] };
  const original = { 1: structuredClone(page) }; original[1].rows[0].values[1] = '2026-01-01';
  return { rows, registry, original, fresh: { 1: page } };
}

test('a separate image reading corroborates the printed date and retains the disputed observation in audit', () => {
  const { rows, registry, original, fresh } = fixture();
  const result = applyCriticalFieldRecovery(rows, registry, original, fresh);
  assert.equal(result.pages[1].rows[0].values[1], '2026-02-01');
  assert.equal(original[1].rows[0].values[1], '2026-01-01');
  assert.equal(result.applied[0].before, '2026-01-01');
  assert.equal(result.applied[0].field, 'transactionDate');
  assert.equal(result.applied.length, 1);
});

test('a disagreeing, incomplete, uncertain, ungrounded or structurally mismatched reread cannot dismiss checks', () => {
  for (const problem of ['disagree', 'uncertain', 'page', 'source', 'rows', 'anchors']) {
    const { rows, registry, original, fresh } = fixture();
    if (problem === 'disagree') fresh[1].rows[0].values[1] = '2026-03-01';
    if (problem === 'uncertain') fresh[1].rows[0].issues.push({ field: 'transactionDate', kind: 'uncertain', reason: '月份模糊' });
    if (problem === 'page') fresh[1].coverage = 'uncertain';
    if (problem === 'source') registry.cells[5].text = '2026-01-01';
    if (problem === 'rows') fresh[1].rows.push(structuredClone(fresh[1].rows[0]));
    if (problem === 'anchors') for (const i of [0, 3, 7]) fresh[1].rows[0].values[i] = '';
    assert.equal(applyCriticalFieldRecovery(rows, registry, original, fresh).applied.length, 0, problem);
  }
});

test('recovery planning is bounded and selects actual conflicts without changing classification review', () => {
  const { registry } = fixture();
  registry.pages = [1, 2];
  const issue: AssemblyIssue = { id: '1', code: 'INDEPENDENT_VALUE_CONFLICT', field: 'transactionDate',
    outputRows: [1], sourceRows: [1], sourceCells: [], sourcePages: [1, 2], severity: 'REQUIRED', message: '月份不同' };
  const plan = planCriticalFieldRecovery([issue, { ...issue, field: 'transactionType', sourcePages: [99] }], registry, 1);
  assert.deepEqual(plan.selected.map(p => p.page), [1]);
  assert.deepEqual(plan.deferred.map(p => p.page), [2]);
  assert.equal(plan.standardAnswersRead, false);
});

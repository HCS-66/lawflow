import test from 'node:test';
import assert from 'node:assert/strict';
import { planAccountRecovery } from '../src/recognition/accountRecoveryPlan';
import type { AssemblyIssue, SourceRegistry } from '../src/recognition/sourceAssembly';

test('recovery planner selects disputed printed pages and inventory, never all rows or standard answers', () => {
  const registry = { pages: [1, 2, 3], cells: {}, rows: { 8: { id: 8, page: 2, table: 1, row: 1, cells: [] } } } satisfies SourceRegistry;
  const issue: AssemblyIssue = { id: 'x', code: 'CONFLICT', field: 'accountNumber', severity: 'REQUIRED',
    outputRows: [1], sourceRows: [8], sourceCells: [], message: 'Conflicting account' };
  const pages = { 1: { pageType: 'account_info', coverage: 'complete', pageIssues: [], rows: [], ownerIdentifiers: [{ role: 'account', value: '12345678' }] } };
  assert.deepEqual(planAccountRecovery([issue], registry, pages).selected.map(p => p.page), [1, 2]);
  assert.deepEqual(planAccountRecovery([{ ...issue, field: 'amount' }], registry, pages).selected, []);
  assert.deepEqual(planAccountRecovery([issue], registry, pages, [1, 2]).selected, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFocusedAccountRecovery, type FocusedAccounts } from '../src/recognition/accountRecovery';
import type { AssembledRow } from '../src/recognition/sourceAssembly';
import type { IndependentPage } from '../src/recognition/independentComparison';
const number = '001234567890';
const values = [number, '', '', '', '2026-01-01', 'OUT', '10.00', '100.00', '', '', '6222000000000011', ''];
const row = (id: number): AssembledRow => ({ id: `r${id}`, values: [...values], sourceRows: [id], fields: Array.from({ length: 12 }, (_, f) => f === 0 ? [{ id, text: number, normalized: number }] : []) });
const info: IndependentPage = { pageType: 'account_info', coverage: 'complete', pageIssues: [], rows: [], ownerIdentifiers: [{ role: 'account', value: number }] };
const scanned: IndependentPage = { pageType: 'transactions', coverage: 'complete', pageIssues: [], rows: [{ row: 1, values: ['001234567891', '2026-01-01', '', 'OUT', '10.00', '100.00', '', '6222000000000011'], rawDirection: '-', issues: [] }] };
const recovery: FocusedAccounts = { bankName: '', issues: [], identifiers: [{ role: 'account', value: number, characters: [...number], table: 1, scope: 'header', label: '账号', uncertainPositions: [] }] };
const context = (page: number, directOwner: boolean) => ({ page, directOwner, table: 1, order: 1, accountKind: 'deposit', description: '' });
test('recovery requires both a printed detailed value and separate account information', () => {
  const rows = [row(1), row(2)]; const contexts = [context(1, false), context(2, true)];
  const registry = { cells: {}, rows: {}, pages: [1, 2, 3] };
  const noProof = applyFocusedAccountRecovery(rows, contexts, registry, { 1: scanned }, { 1: recovery });
  assert.equal(noProof.pages[1].rows[0].values[0], '001234567891');
  const result = applyFocusedAccountRecovery(rows, contexts, registry, { 1: scanned, 3: info }, { 1: recovery });
  assert.equal(result.pages[1].rows[0].values[0], number);
  assert.equal(scanned.rows[0].values[0], '001234567891');
  assert.ok(result.applied[0].sources.some(s => s.includes('focused:')));
});
test('an uncertain reread cannot silently resolve the account', () => {
  const result = applyFocusedAccountRecovery([row(1), row(2)], [context(1, false), context(2, true)], { cells: {}, rows: {}, pages: [1, 2, 3] },
    { 1: scanned, 3: info }, { 1: { ...recovery, identifiers: [{ ...recovery.identifiers[0], uncertainPositions: [12] }] } });
  assert.equal(result.applied.length, 0);
});

test('a labelled customer account can resolve a system-account selection using separate account information', () => {
  const r = row(1);
  const registry = { cells: { 1: { id: 1, text: `客户账号: ${number}`, page: 1, row: null, column: null } }, rows: {}, pages: [1, 3] };
  const metadata = { ...info, ownerIdentifiers: [{ role: 'card', value: number }] };
  const result = applyFocusedAccountRecovery([r], [context(1, false)], registry, { 1: scanned, 3: metadata }, { 1: recovery });
  assert.equal(result.pages[1].rows[0].values[0], number);
  registry.cells[1].text = `系统账号: ${number}`;
  assert.equal(applyFocusedAccountRecovery([r], [context(1, false)], registry, { 1: scanned, 3: metadata }, { 1: recovery }).applied.length, 0);
});

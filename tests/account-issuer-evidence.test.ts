import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAccountIssuers } from '../src/recognition/accountIssuerEvidence';
import type { IndependentPage } from '../src/recognition/independentComparison';
import type { SourceRegistry } from '../src/recognition/sourceAssembly';

const reading = (bankName: string, value: string): IndependentPage => ({ pageType: 'account_info', coverage: 'complete',
  bankName, ownerIdentifiers: [{ role: 'account', value }], rows: [], pageIssues: [] });
test('issuer context requires a printed heading and the same complete account identifier', () => {
  const registry: SourceRegistry = { pages: [1, 2], rows: {}, cells: {
    1: { id: 1, page: 1, row: null, column: null, text: '中国工商银行' },
    2: { id: 2, page: 2, row: null, column: null, text: '中国农业银行' } } };
  const result = collectAccountIssuers(registry, { 1: reading('中国工商银行', '1234567890123456'),
    2: reading('中国农业银行', '9999999999999999') });
  assert.deepEqual([...result.get('1234567890123456')!.keys()], ['中国工商银行']);
  assert.deepEqual([...result.get('9999999999999999')!.keys()], ['中国农业银行']);
  assert.equal(result.get('3456'), undefined);
  registry.cells[1].row = 1;
  assert.equal(collectAccountIssuers(registry, { 1: reading('中国工商银行', '1234567890123456') }).size, 0,
    'a bank in a transaction cell may be the counterparty bank');
});
test('conflicting issuers remain conflicting instead of taking a majority', () => {
  const registry: SourceRegistry = { pages: [1, 2], rows: {}, cells: {
    1: { id: 1, page: 1, row: null, column: null, text: '中国工商银行' },
    2: { id: 2, page: 2, row: null, column: null, text: '中国农业银行' } } };
  const result = collectAccountIssuers(registry, { 1: reading('中国工商银行', '1234567890123456'),
    2: reading('中国农业银行', '1234567890123456') });
  assert.equal(result.get('1234567890123456')!.size, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decidePreflight, qualityWireRequest, type QualityRequest } from '../src/recognition/qualityProtocol';
import { runQualityWorkflow } from '../src/recognition/qualityWorkflow';
import { qualityToWeb } from '../src/recognition/qualityWebAdapter';
import { buildQualitySources, stabilizeQualityMapping } from '../src/recognition/qualitySources';
import { normalizeRecognizedData } from '../src/utils/recognizedDataNormalizer';
import { applyRowReviewDecision } from '../src/review/fieldReview';
import { buildEvidenceReviewIssues } from '../src/review/buildEvidenceReviewIssues';
import { decodeQualityRequest, runQualityModel, validImageBase64 } from '../functions/lib/qualityModel';
import { qualityPrompts } from '../functions/lib/qualityPrompts.generated';
import type { TableMappingPlan } from '../src/recognition/tableMapping';

test('web prompts match the experimental prompts byte for byte', () => {
  for (const policy of Object.values(qualityPrompts)) {
    const text = readFileSync(`scripts/prompts/${policy.file}`, 'utf8');
    assert.equal(policy.prompt, text);
    assert.equal(policy.sha256, createHash('sha256').update(text).digest('hex'));
  }
});
test('Gemini alone cannot drop a page containing text or ink', () => {
  const reading = { pageKind: 'blank' as const, uprightCandidate: 'uncertain' as const, reason: 'blank' };
  assert.equal(decidePreflight(reading, { darkFraction160: 0, darkFraction210: 0, hasPdfText: true }).blankConfirmed, false);
  assert.equal(decidePreflight(reading, { darkFraction160: .001, darkFraction210: .001, hasPdfText: false }).blankConfirmed, false);
  assert.equal(decidePreflight(reading, { darkFraction160: 0, darkFraction210: 0, hasPdfText: false }).blankConfirmed, true);
  assert.equal(decidePreflight({ ...reading, pageKind: 'content', uprightCandidate: 'C' }, { darkFraction160: .01, darkFraction210: .02, hasPdfText: true }).clockwiseRotation, 180);
});
test('large image validation retains full alphabet and padding validation', () => {
  assert.equal(validImageBase64('QUJD'.repeat(500_000)), true);
  for (const value of ['', 'AA=A', 'A===', 'AAA', 'AAAA\nAAA', 'A_AA', 'AAAA=AAA']) assert.equal(validImageBase64(value), false, value);
  for (const value of ['YQ==', 'YWI=', 'YWJj']) assert.equal(validImageBase64(value), true);
});
test('image transport preserves all bytes and rejects injected JSON or extra image lines', () => {
  const input: QualityRequest = { stage: 'primary', images: ['QUJD'.repeat(500_000)] };
  const wire = qualityWireRequest(input);
  assert.deepEqual(decodeQualityRequest(wire.body, wire.contentType), input);
  assert.deepEqual(decodeQualityRequest(JSON.stringify(input), 'application/json'), input);
  for (const invalid of ['primary\nYQ==\nYQ==', 'primary\nYQ=="}', 'mapping\nYQ==', 'unknown\nYQ=='])
    assert.throws(() => decodeQualityRequest(invalid, wire.contentType));
});
test('compact Gemini transport keeps all four full images, ordering, prompt and generation settings', async () => {
  const input: QualityRequest = { stage: 'preflight', images: ['YQ==', 'Yg==', 'Yw==', 'ZA=='] };
  const wire = qualityWireRequest(input); const decoded = decodeQualityRequest(wire.body, wire.contentType);
  let request: any;
  const value = { pageKind: 'content', uprightCandidate: 'B', reason: 'test' };
  const fetcher = (async (_url: any, init: any) => {
    request = JSON.parse(init.body);
    return new Response('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] }, finishReason: 'STOP' }] }) + '\n\n');
  }) as typeof fetch;
  const result = await runQualityModel(decoded, { GEMINI_API_KEY: 'test', DASHSCOPE_API_KEY: 'test' }, new AbortController().signal, fetcher);
  assert.deepEqual(result.result, value);
  assert.deepEqual(request.contents, [{ role: 'user', parts: [{ text: qualityPrompts.preflight.prompt },
    ...input.images!.flatMap((data, i) => [{ text: `候选${'ABCD'[i]}` }, { inlineData: { mimeType: 'image/jpeg', data } }]) ] }]);
  assert.deepEqual(request.generationConfig, { temperature: 0, thinkingConfig: { thinkingLevel: 'low' }, responseMimeType: 'application/json', maxOutputTokens: 2048 });
});
const sourcePage = { nearTableText: ['某银行', '001234567890'], tables: [{ rows: [['2026-07-10', '支出', '10.00', '100.00', '账户转账', '李某', '009876543210']] }] };
const mapping: TableMappingPlan = { tables: [{ page: 1, table: 1, kind: 'transactions', accountKind: 'deposit', groups: [[1]], ignored: [], directionCodes: null,
  fields: { bankName: { fixed: 1 }, accountNumber: { fixed: 2 }, transactionDate: { row: 0, col: 1 }, direction: { row: 0, col: 2 }, amount: { row: 0, col: 3 }, balance: { row: 0, col: 4 },
    description: { row: 0, col: 5 }, counterpartyName: { row: 0, col: 6 }, counterpartyAccount: { row: 0, col: 7 } } }], typeRules: [{ accountKind: 'deposit', text: '账户转账', type: '账户转账' }] };
test('workflow preflights ALL pages first, skips confirmed blank and sends one text-only full list to mapping', async () => {
  const calls: Array<{ input: QualityRequest; page: number }> = [], rotations: number[] = [];
  const out = await runQualityWorkflow({ totalPages: 2, signal: new AbortController().signal, progress() {},
    preflightImages: async page => ({ images: ['A', 'B', 'C', 'D'], metrics: { darkFraction160: page === 2 ? 0 : .1, darkFraction210: page === 2 ? 0 : .1, hasPdfText: page === 1 } }),
    image: async (_page, rotation) => { rotations.push(rotation); return 'image'; },
    call: async (input, page) => {
      calls.push({ input, page }); let result: any;
      if (input.stage !== 'preflight') assert.equal(calls.filter(c => c.input.stage === 'preflight').length, 2);
      if (input.stage === 'preflight') result = { pageKind: page === 1 ? 'content' : 'blank', uprightCandidate: page === 1 ? 'B' : 'uncertain', reason: 'test' };
      else if (input.stage === 'primary') result = sourcePage;
      else if (input.stage === 'context') result = { nearTableText: [], tables: [] };
      else if (input.stage === 'mapping') { assert.equal(input.images, undefined); assert.equal((input.source as any[]).length, 2); result = mapping; }
      else if (input.stage === 'independent') result = { pageType: 'transactions', coverage: 'complete', pageIssues: [], bankName: '某银行', rows: [
        { row: 1, values: ['001234567890', '2026-07-10', '', 'OUT', '10.00', '100.00', '李某', '009876543210'], rawDirection: '支出', issues: [] }] };
      else throw new Error(`Unexpected ${input.stage}`);
      return { result: structuredClone(result), finishReason: 'STOP', model: 'test', promptSHA256: 'test' };
    }
  });
  assert.equal(out.result.complete, true); assert.equal(out.result.rows.length, 1);
  assert.deepEqual(rotations, [90]); assert.equal(calls.filter(c => c.input.stage === 'mapping').length, 1);
  assert.ok(calls.every(c => c.page !== 2 || c.input.stage === 'preflight'));
});
test('web bridge preserves all 12 columns and field-specific checks across normalization and human review', () => {
  const { registry } = buildQualitySources([sourcePage]);
  const values = ['001234567890', '某甲', '某银行', '', '2026-07-10', 'OUT', '10.00', '100.00', '', '李某', '009876543210', ''];
  const web = qualityToWeb({ complete: true, rows: [{ id: 'E1', values, sourceObservationIds: ['source:1'] }], pending: [
    { id: 'TYPE1', code: 'ANALYSIS_TYPE_UNRESOLVED', field: 'transactionType', outputRows: [1], sourceRows: [1], sourceCells: [], severity: 'REQUIRED', message: '请确认交易类型' }
  ] }, registry, 'test.pdf', 1);
  const normalized = normalizeRecognizedData(web.accounts, web.transactions), row = normalized.transactions[0];
  assert.equal(row.transactionDate, '2026-07-10'); assert.equal(row.transactionTime, ''); assert.equal(row.accountNumber, '001234567890');
  assert.equal(row.counterpartyAccount, '009876543210'); assert.equal(row.transactionType, '');
  assert.equal(row.fieldEvidence?.amount?.originalValue, row.fieldEvidence?.amount?.currentValue);
  assert.deepEqual(row.candidateReview?.requiredFields, ['transactionType']);
  assert.equal(buildEvidenceReviewIssues(normalized.accounts[0], normalized.transactions).filter(i => i.severity === 'REQUIRED').length, 1);
  const wrongField = applyRowReviewDecision(row, ['amount'], 'ACCEPT_CURRENT');
  assert.equal(wrongField.candidateReview?.status, 'PENDING'); assert.equal(wrongField.transactionDate, '2026-07-10');
  const reviewed = applyRowReviewDecision({ ...row, transactionType: '账户转账' }, ['transactionType'], 'ACCEPT_CURRENT');
  assert.equal(reviewed.candidateReview?.status, 'CONFIRMED'); assert.equal(reviewed.transactionDate, '2026-07-10');
});
test('unchanged page selectors are rebased after an earlier page gains source cells', () => {
  const before = buildQualitySources([{ nearTableText: ['intro'], tables: [] }, sourcePage]);
  const after = buildQualitySources([{ nearTableText: ['intro', 'extra'], tables: [] }, sourcePage]);
  const prior = structuredClone(mapping); prior.tables[0].page = 2; prior.tables[0].fields.bankName = { fixed: 2 }; prior.tables[0].fields.accountNumber = { fixed: 3 };
  const latest = structuredClone(prior); latest.tables[0].fields.accountNumber = null;
  const fixed = stabilizeQualityMapping(prior, latest, before.registry, after.registry);
  assert.deepEqual(fixed.tables[0].fields.accountNumber, { fixed: 4 });
});
test('server uses Qwen only for transcription and rejects unfinished output', async () => {
  let request: any;
  const fetcher = (async (_url: any, init: any) => { request = JSON.parse(init.body); return Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }); }) as typeof fetch;
  await assert.rejects(runQualityModel({ stage: 'primary', images: ['aGVsbG8='] }, { GEMINI_API_KEY: 'test', DASHSCOPE_API_KEY: 'test' }, new AbortController().signal, fetcher), /未完成/);
  assert.equal(request.messages[0].content[0].text, qualityPrompts.primary.prompt);
  assert.equal(request.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,aGVsbG8=');
  assert.equal(request.reasoning_effort, 'low');
});

test('user cancellation wins over an earlier network error in another page worker', async () => {
  const controller = new AbortController();
  await assert.rejects(runQualityWorkflow({ totalPages: 2, signal: controller.signal, progress() {},
    preflightImages: async page => {
      if (page === 1) throw new TypeError('Failed to fetch');
      controller.abort();
      return { images: [], metrics: { darkFraction160: 0, darkFraction210: 0, hasPdfText: false } };
    }, image: async () => '',
    call: async () => ({ result: { pageKind: 'blank', uprightCandidate: 'uncertain', reason: 'blank' }, finishReason: 'STOP', model: 'test', promptSHA256: 'test' })
  }), error => error instanceof DOMException && error.name === 'AbortError');
});

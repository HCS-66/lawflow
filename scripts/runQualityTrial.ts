import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runQualityTrial } from '../src/recognition/qualityTrialPipeline';
import { STATEMENT_COLUMNS } from '../src/recognition/sourceAssembly';
import type { IndependentPage } from '../src/recognition/independentComparison';
import type { FocusedAccounts } from '../src/recognition/accountRecovery';
const dir = resolve(process.argv[2] || '');
const independentDir = resolve(process.argv[3] || '');
const outputDir = resolve(process.argv[4] || '');
if (existsSync(outputDir)) throw new Error('Use a new trial directory to preserve frozen outputs');
const registry = JSON.parse(readFileSync(resolve(dir, 'registry.json'), 'utf8'));
const mapping = JSON.parse(readFileSync(resolve(dir, 'layout.json'), 'utf8'));
const independent: Record<number, IndependentPage> = {};
const inputs: Record<string, string> = {};
for (const page of registry.pages) {
  const file = resolve(independentDir, `page-${String(page).padStart(2, '0')}.json`);
  if (existsSync(file)) {
    const bytes = readFileSync(file); inputs[file] = createHash('sha256').update(bytes).digest('hex');
    const wrapper = JSON.parse(bytes.toString());
    const blank = wrapper.finishReason === 'SKIPPED_BLANK'
      && wrapper.preflight?.policyVersion === 'FULL_PAGE_PREFLIGHT_V1'
      && wrapper.preflight.blankConfirmed === true && wrapper.preflight.pixelBlank === true
      && wrapper.preflight.hasPdfText === false && wrapper.preflight.modelPageKind === 'blank'
      && /^[a-f0-9]{64}$/.test(wrapper.preflight.imageSHA256 || '')
      && /^[a-f0-9]{64}$/.test(wrapper.preflight.responseSHA256 || '')
      && wrapper.result?.pageType === 'blank' && wrapper.result.coverage === 'complete'
      && Array.isArray(wrapper.result.rows) && wrapper.result.rows.length === 0;
    if (wrapper.finishReason === 'STOP' || blank) independent[page] = wrapper.result;
  }
}
const singleIssuerDocument = process.argv.includes('--single-issuer');
const issuerArg = process.argv.indexOf('--issuer-bank');
const issuerBankName = issuerArg >= 0 ? process.argv[issuerArg + 1] : undefined;
const accountRecovery: Record<number, FocusedAccounts> = {};
const recoveryArg = process.argv.indexOf('--account-recovery-dir');
if (recoveryArg >= 0) {
  const recoveryDir = resolve(process.argv[recoveryArg + 1]);
  for (const page of registry.pages) {
    const file = resolve(recoveryDir, `page-${String(page).padStart(2, '0')}.json`);
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file); inputs[file] = createHash('sha256').update(bytes).digest('hex');
    const response = JSON.parse(bytes.toString());
    if (response.finishReason === 'STOP') accountRecovery[page] = response.result;
  }
}
const criticalRereads: Record<number, IndependentPage> = {};
const fieldRecoveryArg = process.argv.indexOf('--field-recovery-dir');
if (fieldRecoveryArg >= 0) {
  for (const page of registry.pages) {
    const file = resolve(process.argv[fieldRecoveryArg + 1], `page-${String(page).padStart(2, '0')}.json`);
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file); inputs[file] = createHash('sha256').update(bytes).digest('hex');
    const response = JSON.parse(bytes.toString());
    if (response.finishReason === 'STOP' && response.page === page) criticalRereads[page] = response.result;
  }
}
const result = runQualityTrial(mapping, registry, independent, { singleIssuerDocument, issuerBankName }, accountRecovery, criticalRereads);
mkdirSync(outputDir, { recursive: true });
const snapshot = resolve(outputDir, 'policy-snapshot');
mkdirSync(snapshot);
const policies: Record<string, string> = {};
for (const name of ['sourceAssembly', 'sourceFragments', 'semanticText', 'accountIssuerEvidence', 'rowGrouping', 'columnRecovery', 'tableMapping', 'signedAmountDirection', 'printedTransactionType', 'criticalFieldRecovery', 'independentComparison', 'observationConsolidation', 'unmergedViews', 'accountRecovery', 'accountInventoryBinding', 'printedOwnerPrefixes', 'qualityTrialPipeline', 'acceptanceEvaluation']) {
  const bytes = readFileSync(resolve('src/recognition', `${name}.ts`));
  writeFileSync(resolve(snapshot, `${name}.ts`), bytes);
  policies[name] = createHash('sha256').update(bytes).digest('hex');
}
for (const file of ['registry.json', 'layout.json']) inputs[resolve(dir, file)] = createHash('sha256').update(readFileSync(resolve(dir, file))).digest('hex');
writeFileSync(resolve(outputDir, 'manifest.json'), JSON.stringify({ inputs, policies, singleIssuerDocument, issuerBankName, standardAnswersRead: false }, null, 2));
writeFileSync(resolve(outputDir, 'result.json'), JSON.stringify(result, null, 2));
const quote = (s: string) => /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
writeFileSync(resolve(outputDir, 'candidate.csv'), '\uFEFF' + [STATEMENT_COLUMNS, ...result.rows.map(r => r.values)].map(r => r.map(quote).join(',')).join('\r\n') + '\r\n');
const counts: Record<string, number> = {};
for (const issue of result.pending) counts[`${issue.code}:${issue.field}`] = (counts[`${issue.code}:${issue.field}`] || 0) + 1;
console.log(JSON.stringify({ rows: result.rows.length, complete: result.complete, pendingRows: new Set(result.pending.flatMap(i => i.outputRows)).size,
  pending: counts, resolved: result.resolved.length, transformations: result.transformations.length }));

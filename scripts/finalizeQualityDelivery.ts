import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { qualityDeliveryStatus, withAnalysisTypeChecks } from '../src/review/qualityDelivery';
const [trial, mapping, destination] = process.argv.slice(2).map(p => resolve(p));
if (existsSync(destination)) throw new Error('Delivery output is immutable; choose a new directory');
const bytes = readFileSync(resolve(trial, 'result.json'));
const registryBytes = readFileSync(resolve(mapping, 'registry.json'));
const result = withAnalysisTypeChecks(JSON.parse(bytes.toString()), JSON.parse(registryBytes.toString()));
const state = qualityDeliveryStatus(result);
mkdirSync(destination, { recursive: true });
writeFileSync(resolve(destination, 'result.json'), JSON.stringify(result, null, 2));
writeFileSync(resolve(destination, 'registry.json'), registryBytes);
writeFileSync(resolve(destination, 'candidate.csv'), readFileSync(resolve(trial, 'candidate.csv')));
writeFileSync(resolve(destination, 'review-state.json'), JSON.stringify(state, null, 2));
const policy = readFileSync(resolve('src/review/qualityDelivery.ts'));
writeFileSync(resolve(destination, 'qualityDelivery.ts.snapshot'), policy);
writeFileSync(resolve(destination, 'manifest.json'), JSON.stringify({
  sourceTrial: trial, sourceMapping: mapping, standardAnswersRead: false,
  predictionSHA256: createHash('sha256').update(bytes).digest('hex'),
  registrySHA256: createHash('sha256').update(registryBytes).digest('hex'),
  deliveryPolicySHA256: createHash('sha256').update(policy).digest('hex'),
  valuesChanged: false
}, null, 2));
console.log(JSON.stringify({ status: state.status, rows: result.rows.length, requiredRows: state.requiredRowCount,
  documentChecks: state.documentCheckCount, canExportAsFinal: state.canExportAsFinal }));

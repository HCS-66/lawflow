import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { evaluateProductAcceptance } from '../src/recognition/acceptanceEvaluation';
import { enforcementTruthProfile, ENFORCEMENT_ACCEPTANCE_PROFILE } from '../src/recognition/acceptanceProfile';
const path = resolve(process.argv[2]);
const input = JSON.parse(readFileSync(path, 'utf8'));
const expected = input.profile === 'enforcement' ? input.expected.map(enforcementTruthProfile) : input.expected;
const evaluation = evaluateProductAcceptance(expected, input.actual, input.alignment, input.alerts, input.protocol);
writeFileSync(process.argv[3] ? resolve(process.argv[3]) : resolve(dirname(path), 'evaluation.json'), JSON.stringify({ ...evaluation,
  profile: input.profile === 'enforcement' ? ENFORCEMENT_ACCEPTANCE_PROFILE : 'FUNDS_FACTS_V1',
  predictionSHA256: input.predictionSHA256, goldSHA256: input.goldSHA256,
  alignmentMethods: input.alignmentMethods, limitations: input.limitations }, null, 2));
const { errors, ...summary } = evaluation;
const fields: Record<string, number> = {};
for (const error of errors) fields[error.field] = (fields[error.field] || 0) + 1;
console.log(JSON.stringify({ ...summary, errorFields: fields }, null, 2));

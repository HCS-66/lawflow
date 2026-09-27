import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planPrimaryRecovery } from '../src/recognition/primaryRecoveryPlan';
const [trial, mapping, output] = process.argv.slice(2);
const result = JSON.parse(readFileSync(resolve(trial, 'result.json'), 'utf8'));
const registry = JSON.parse(readFileSync(resolve(mapping, 'registry.json'), 'utf8'));
const plan = planPrimaryRecovery(result.pending, registry);
writeFileSync(output, JSON.stringify(plan, null, 2));
console.log(plan.selected.map(p => p.page).join(','));

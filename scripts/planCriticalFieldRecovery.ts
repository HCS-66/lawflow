import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planCriticalFieldRecovery } from '../src/recognition/criticalFieldRecovery';
const [trial, mapping, output] = process.argv.slice(2);
const result = JSON.parse(readFileSync(resolve(trial, 'result.json'), 'utf8'));
const registry = JSON.parse(readFileSync(resolve(mapping, 'registry.json'), 'utf8'));
const plan = planCriticalFieldRecovery(result.pending, registry);
writeFileSync(output, JSON.stringify(plan, null, 2));
console.log(JSON.stringify({ selectedPages: plan.selected.map(p => p.page), deferredPages: plan.deferred.map(p => p.page) }));

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assembleFromSources, STATEMENT_COLUMNS } from '../src/recognition/sourceAssembly';

const directory = resolve(process.argv[2] || '');
const registry = JSON.parse(readFileSync(resolve(directory, 'registry.json'), 'utf8'));
const plan = JSON.parse(readFileSync(resolve(directory, 'assembly.json'), 'utf8'));
const result = assembleFromSources(plan, registry);
writeFileSync(resolve(directory, 'assembled.json'), JSON.stringify(result, null, 2));
const quote = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
writeFileSync(resolve(directory, 'candidate.csv'), '\uFEFF' + [STATEMENT_COLUMNS, ...result.rows.map(row => row.values)]
  .map(row => row.map(quote).join(',')).join('\r\n') + '\r\n');
const counts: Record<string, number> = {};
for (const issue of result.issues) counts[issue.code] = (counts[issue.code] || 0) + 1;
console.log(JSON.stringify({ rows: result.rows.length, complete: result.complete, issues: counts }));

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { materializeTableMapping } from '../src/recognition/tableMapping';
import { STATEMENT_COLUMNS } from '../src/recognition/sourceAssembly';

const dir = resolve(process.argv[2] || '');
const registry = JSON.parse(readFileSync(resolve(dir, 'registry.json'), 'utf8'));
const mapping = JSON.parse(readFileSync(resolve(dir, 'layout.json'), 'utf8'));
const result = materializeTableMapping(mapping, registry);
writeFileSync(resolve(dir, 'observations.json'), JSON.stringify(result, null, 2));
const quote = (s: string) => /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
writeFileSync(resolve(dir, 'observations.csv'), '\uFEFF' + [STATEMENT_COLUMNS, ...result.rows.map(r => r.values)].map(r => r.map(quote).join(',')).join('\r\n'));
const counts: Record<string, number> = {};
for (const issue of result.issues) counts[issue.code] = (counts[issue.code] || 0) + 1;
console.log(JSON.stringify({ rows: result.rows.length, complete: result.complete, issues: counts }));

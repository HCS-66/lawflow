import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareIndependentReadings, type IndependentPage } from '../src/recognition/independentComparison';
const dir = resolve(process.argv[2] || '');
const independentDir = resolve(process.argv[3] || '');
const registry = JSON.parse(readFileSync(resolve(dir, 'registry.json'), 'utf8'));
const observations = JSON.parse(readFileSync(resolve(dir, 'observations.json'), 'utf8'));
const pages: Record<number, IndependentPage> = {};
for (const page of registry.pages) {
  const file = resolve(independentDir, `page-${String(page).padStart(2, '0')}.json`);
  if (existsSync(file)) {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (record.finishReason === 'STOP') pages[page] = record.result;
  }
}
const report = compareIndependentReadings(observations.rows, registry, pages);
writeFileSync(resolve(dir, 'independent-comparison.json'), JSON.stringify(report, null, 2));
const counts: Record<string, number> = {};
for (const issue of report.issues) counts[`${issue.code}:${issue.field}`] = (counts[`${issue.code}:${issue.field}`] || 0) + 1;
console.log(JSON.stringify({ pairs: report.pairs.length, issues: counts }));

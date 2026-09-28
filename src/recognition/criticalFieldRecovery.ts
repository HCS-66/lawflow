import { alignIndependentRows, independentValues, KEY_READER_COLUMNS, type IndependentPage } from './independentComparison';
import { STATEMENT_COLUMNS, type AssembledRow, type AssemblyIssue, type SourceRegistry } from './sourceAssembly';

const FIELDS = [0, 4, 5, 6, 7, 9, 10];

export function planCriticalFieldRecovery(issues: AssemblyIssue[], registry: SourceRegistry, maxPages = 12) {
  const reasons = new Map<number, Set<string>>();
  for (const issue of issues) {
    if (issue.severity === 'ADVISORY' || !['INDEPENDENT_VALUE_CONFLICT', 'INDEPENDENT_SOURCE_UNCERTAIN'].includes(issue.code)
      || !FIELDS.some(f => STATEMENT_COLUMNS[f] === issue.field)) continue;
    const pages = [...(issue.sourcePages || []), ...issue.sourceRows.flatMap(id => registry.rows[id] ? [registry.rows[id].page] : [])];
    for (const page of pages) if (registry.pages.includes(page)) {
      const values = reasons.get(page) || new Set<string>(); values.add(`${issue.code}:${issue.field}`); reasons.set(page, values);
    }
  }
  const all = [...reasons].sort((a, b) => a[0] - b[0]).map(([page, reason]) => ({ page, reasons: [...reason] }));
  return { version: 1, mode: 'FULL_PAGE_CRITICAL_DISAGREEMENTS', standardAnswersRead: false,
    selected: all.slice(0, maxPages), deferred: all.slice(maxPages), complete: all.length <= maxPages };
}

/** A third image-only reading can corroborate an existing printed value, never manufacture a replacement. */
export function applyCriticalFieldRecovery(rows: AssembledRow[], registry: SourceRegistry,
  original: Record<number, IndependentPage>, rereads: Record<number, IndependentPage>) {
  const pages = structuredClone(original);
  const applied: Array<{ page: number; observation: number; independentRow: number; field: string;
    before: string; after: string; sources: string[] }> = [];
  for (const [pageText, reread] of Object.entries(rereads)) {
    const pageNumber = Number(pageText), page = pages[pageNumber];
    if (!page || page.coverage !== 'complete' || page.pageIssues.length
      || reread.coverage !== 'complete' || reread.pageIssues.length) continue;
    const located = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.sourceRows.some(id => registry.rows[id]?.page === pageNumber))
      .sort((a, b) => {
        const order = (r: AssembledRow) => Math.min(...r.sourceRows.filter(id => registry.rows[id].page === pageNumber)
          .map(id => registry.rows[id].table * 100000 + registry.rows[id].row));
        return order(a.row) - order(b.row);
      });
    if (reread.rows.length !== located.length || page.rows.length !== located.length) continue;
    const values = located.map(x => x.row.values), first = page.rows.map(independentValues), fresh = reread.rows.map(independentValues);
    const oldPairs = new Map(alignIndependentRows(values, first).pairs.map(p => [p.left, p.right]));
    const newPairs = alignIndependentRows(values, fresh).pairs;
    for (const pair of newPairs) {
      const oldIndex = oldPairs.get(pair.left);
      if (oldIndex === undefined) continue;
      const own = located[pair.left], target = page.rows[oldIndex], observed = reread.rows[pair.right];
      for (const field of FIELDS) {
        if (field === 9 && (own.row.values[10] || first[oldIndex][10] || fresh[pair.right][10])) continue;
        const column = STATEMENT_COLUMNS[field], value = own.row.values[field];
        if (!value || fresh[pair.right][field] !== value || observed.issues.some(i => i.field === column)
          || (!target.issues.some(i => i.field === column) && first[oldIndex][field] === value)) continue;
        const proof = own.row.fields[field];
        if (!proof.length || !proof.every(s => s.normalized === value && registry.cells[s.id]?.text.includes(s.text))) continue;
        const anchors = [0, 4, 5, 6, 7, 10].filter(f => f !== field && values[pair.left][f]
          && values[pair.left][f] === fresh[pair.right][f] && !observed.issues.some(i => i.field === STATEMENT_COLUMNS[f]));
        if (anchors.length < 3) continue;
        const index = KEY_READER_COLUMNS.indexOf(field as typeof KEY_READER_COLUMNS[number]);
        applied.push({ page: pageNumber, observation: own.index + 1, independentRow: target.row, field: column,
          before: target.values[index], after: value, sources: [...proof.map(s => `primary:cell:${s.id}`),
            `criticalReread:p${pageNumber}:row${observed.row}:${column}`] });
        target.values[index] = value;
        target.issues = target.issues.filter(i => i.field !== column);
      }
    }
  }
  return { pages, applied };
}

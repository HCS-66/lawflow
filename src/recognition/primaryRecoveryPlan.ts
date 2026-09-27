import type { AssemblyIssue, SourceRegistry } from './sourceAssembly';

/** Whole-page source rereads are triggered only by observed structural disagreement. */
export function planPrimaryRecovery(issues: AssemblyIssue[], registry: SourceRegistry, maxPages = 6) {
  const codes = new Set(['INDEPENDENT_ROW_UNMATCHED', 'INDEPENDENT_EXTRA_OBSERVATION',
    'UNASSIGNED_SOURCE_ROW', 'SOURCE_ROW_REUSED', 'INDEPENDENT_PAGE_INCOMPLETE']);
  const selected = new Map<number, Set<string>>();
  for (const issue of issues) {
    if (!codes.has(issue.code) || issue.severity === 'ADVISORY') continue;
    const pages = new Set([...(issue.sourcePages || []), ...issue.sourceRows.map(r => registry.rows[r]?.page),
      ...issue.sourceCells.map(c => registry.cells[c]?.page)].filter((p): p is number => Boolean(p)));
    for (const page of pages) {
      const reasons = selected.get(page) || new Set<string>(); reasons.add(issue.code); selected.set(page, reasons);
    }
  }
  const pages = [...selected].sort((a, b) => a[0] - b[0]).map(([page, reasons]) => ({ page, reasons: [...reasons] }));
  return { standardAnswersRead: false, mode: 'FULL_PAGE_PRIMARY_REREAD', selected: pages.slice(0, maxPages),
    deferred: pages.slice(maxPages), complete: pages.length <= maxPages };
}

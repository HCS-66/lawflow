import type { AssemblyIssue, SourceRegistry } from './sourceAssembly';
import type { IndependentPage } from './independentComparison';

/** Plan from unresolved evidence alone, before loading any standard answers. */
export function planAccountRecovery(issues: AssemblyIssue[], registry: SourceRegistry,
  independent: Record<number, IndependentPage>, alreadyAttempted: number[] = [], maxPages = 12) {
  const reasons = new Map<number, Set<string>>();
  const add = (page: number, reason: string) => {
    if (!registry.pages.includes(page) || alreadyAttempted.includes(page)) return;
    const values = reasons.get(page) || new Set<string>();
    values.add(reason); reasons.set(page, values);
  };
  for (const issue of issues) {
    if (!['accountNumber', 'bankName'].includes(issue.field || '') || issue.severity === 'ADVISORY') continue;
    for (const page of issue.sourcePages || []) add(page, issue.code);
    for (const row of issue.sourceRows) if (registry.rows[row]) add(registry.rows[row].page, issue.code);
    for (const cell of issue.sourceCells) if (registry.cells[cell]) add(registry.cells[cell].page, issue.code);
  }
  // Account-information OCR can create an apparent competing account, so re-read its source too.
  if (reasons.size) for (const [page, reading] of Object.entries(independent)) {
    if (['account_info', 'document'].includes(reading.pageType) && reading.ownerIdentifiers?.some(i => i.role === 'account')) {
      add(Number(page), 'ACCOUNT_INVENTORY_SUPPORTS_DISPUTED_OWNER');
    }
  }
  const all = [...reasons].map(([page, values]) => ({ page, reasons: [...values] })).sort((a, b) => {
    const direct = (item: typeof a) => item.reasons.some(reason => reason !== 'ACCOUNT_INVENTORY_SUPPORTS_DISPUTED_OWNER');
    return Number(direct(b)) - Number(direct(a)) || a.page - b.page;
  });
  return { version: 1, mode: 'FULL_PAGE_OWNER_ACCOUNTS', standardAnswersRead: false,
    selected: all.slice(0, maxPages).sort((a, b) => a.page - b.page),
    deferred: all.slice(maxPages).sort((a, b) => a.page - b.page), complete: all.length <= maxPages };
}

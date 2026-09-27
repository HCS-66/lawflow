import type { AssembledRow, SourceRegistry } from './sourceAssembly';
import { alignIndependentRows, independentValues, type IndependentPage } from './independentComparison';
import type { ObservationContext } from './observationConsolidation';

export interface FocusedAccounts {
  bankName: string;
  identifiers: Array<{ role: 'account' | 'card'; value: string; characters: string[]; table: number;
    scope: 'header' | 'transaction_column' | 'account_information'; label: string; uncertainPositions: number[] }>;
  issues: string[];
}

/** A later reading alone is insufficient: require both a printed detailed account and separate account information. */
export function applyFocusedAccountRecovery(rows: AssembledRow[], context: ObservationContext[], registry: SourceRegistry,
  original: Record<number, IndependentPage>, recovery: Record<number, FocusedAccounts>) {
  const pages = structuredClone(original);
  const applied: Array<{ page: number; target: string; before: string; after: string; sources: string[] }> = [];
  const skipped: Array<{ page: number; reason: string }> = [];
  for (const [pageText, reading] of Object.entries(recovery)) {
    const pageNumber = Number(pageText), page = pages[pageNumber];
    if (!page || reading.issues.length) { skipped.push({ page: pageNumber, reason: 'Missing original page or unresolved recovery issues' }); continue; }
    const eligible = reading.identifiers.flatMap(identifier => {
      if (!/^\d{8,32}$/.test(identifier.value) || identifier.characters.join('') !== identifier.value || identifier.uncertainPositions.length) return [];
      const detailed = rows.flatMap((row, index) => context[index].directOwner && context[index].page !== pageNumber && row.values[0] === identifier.value
        ? row.fields[0].map(s => `primary:cell:${s.id}`) : []);
      const explicitCustomer = rows.flatMap((row, index) => context[index].page === pageNumber && row.values[0] === identifier.value
        ? row.fields[0].filter(s => /(?:客户账[号戶户]|客户帐号|查询卡号)/.test(registry.cells[s.id]?.text || '')).map(s => `primary:cell:${s.id}:explicitCustomerAccount`) : []);
      const separateInformation = Object.entries(original).flatMap(([p, item]) => Number(p) !== pageNumber
        && ['document', 'account_info'].includes(item.pageType)
        && item.ownerIdentifiers?.some(i => (i.role === identifier.role || explicitCustomer.length > 0) && i.value === identifier.value)
        ? [`independent:p${p}:ownerIdentifiers`] : []);
      return (detailed.length || explicitCustomer.length) && separateInformation.length ? [{ identifier, sources: [...detailed.slice(0, 3), ...explicitCustomer.slice(0, 1), ...separateInformation,
        `focused:p${pageNumber}:table${identifier.table}:${identifier.scope}`] }] : [];
    });
    const located = rows.map((row, index) => ({ row, index })).filter(item => context[item.index].page === pageNumber)
      .sort((a, b) => context[a.index].table - context[b.index].table || context[a.index].order - context[b.index].order);
    const alignment = alignIndependentRows(located.map(r => r.row.values), page.rows.map(independentValues));
    for (const pair of alignment.pairs) {
      const table = context[located[pair.left].index].table;
      const choices = eligible.filter(c => c.identifier.table === table && c.identifier.scope !== 'account_information');
      const accountChoices = choices.filter(c => c.identifier.role === 'account');
      const relevant = accountChoices.length ? accountChoices : choices;
      if (new Set(relevant.map(c => c.identifier.value)).size !== 1) continue;
      const picked = relevant[0];
      const target = page.rows[pair.right];
      applied.push({ page: pageNumber, target: `row:${target.row}:accountNumber`, before: target.values[0], after: picked.identifier.value, sources: picked.sources });
      target.values[0] = picked.identifier.value;
      target.issues = target.issues.filter(i => i.field !== 'accountNumber');
    }
    if (!page.rows.length && ['document', 'account_info'].includes(page.pageType)) {
      const choices = eligible.filter(c => c.identifier.scope === 'account_information' || c.identifier.scope === 'header');
      for (const role of ['account', 'card'] as const) {
        const matching = choices.filter(c => c.identifier.role === role);
        const previous = (page.ownerIdentifiers || []).filter(i => i.role === role);
        if (matching.length !== 1 || previous.length > 1) continue;
        const choice = matching[0];
        applied.push({ page: pageNumber, target: `ownerIdentifiers:${role}`, before: previous[0]?.value || '', after: choice.identifier.value, sources: choice.sources });
        page.ownerIdentifiers = [...(page.ownerIdentifiers || []).filter(i => i.role !== role), { role, value: choice.identifier.value }];
      }
    }
    if (!applied.some(a => a.page === pageNumber)) skipped.push({ page: pageNumber, reason: 'No unique account with corroborating detailed rows and separate account information' });
  }
  return { pages, applied, skipped };
}

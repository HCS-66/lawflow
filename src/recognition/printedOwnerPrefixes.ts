import { accountFromSource, type AssembledRow, type SourceRegistry } from './sourceAssembly';
import type { ObservationContext } from './observationConsolidation';
import type { IndependentPage } from './independentComparison';

/** Restore only a clipped owner column with its printed full-page header and a separate account inventory. */
export function recoverPrintedOwnerPrefixes(rows: AssembledRow[], context: ObservationContext[], registry: SourceRegistry,
  independent: Record<number, IndependentPage>) {
  const output: Array<{ observation: number; value: string; sources: string[] }> = [];
  rows.forEach((row, i) => {
    const prefix = row.values[0], page = context[i].page;
    if (!context[i].directOwner || !/^\d{8,11}$/.test(prefix)) return;
    const headers = Object.values(registry.cells).flatMap(cell => {
      if (cell.page !== page || cell.row !== null) return [];
      const value = accountFromSource(cell.text);
      return value && /^\d{12,32}$/.test(value) && value.startsWith(prefix) ? [{ value, cell }] : [];
    });
    const choices = new Set(headers.map(h => h.value));
    if (choices.size !== 1) return;
    const value = [...choices][0];
    const detailed = rows.flatMap((r, n) => context[n].page !== page && context[n].directOwner && r.values[0] === value ? [n + 1] : []);
    const inventories = Object.entries(independent).flatMap(([p, info]) => Number(p) !== page && ['account_info', 'document'].includes(info.pageType)
      && info.ownerIdentifiers?.some(id => id.value === value && ['account', 'card'].includes(id.role)) ? [p] : []);
    if (!detailed.length || !inventories.length) return;
    output.push({ observation: i + 1, value, sources: [...headers.map(h => `cell:${h.cell.id}`),
      ...detailed.slice(0, 3).map(n => `observation:${n}:printedOwner`), ...inventories.map(p => `independent:p${p}:ownerIdentifiers`)] });
  });
  return output;
}

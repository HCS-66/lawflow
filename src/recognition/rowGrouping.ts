import { dateFromSource, moneyFromSource, type SourceRegistry } from './sourceAssembly';
import type { MappedTable, ColumnSelector } from './tableMapping';

/** Recover an invalid two-line partition only when the printed date/amount pattern proves every boundary. */
export function repairUniformRowGroups(table: MappedTable, registry: SourceRegistry) {
  const sourceRows = Object.values(registry.rows).filter(r => r.page === table.page && r.table === table.table).sort((a, b) => a.row - b.row);
  const ignored = new Set(table.ignored.flatMap(item => item.r));
  const expected = sourceRows.filter(row => !ignored.has(row.id));
  const used = table.groups.flat();
  if (used.length === expected.length && new Set(used).size === used.length && expected.every(r => used.includes(r.id))) return null;
  if (!table.groups.length || table.groups.some(group => group.length !== 2) || expected.length % 2) return null;
  const date = table.fields.transactionDate, amount = table.fields.amount;
  if (!date || !amount || !('row' in date) || !('row' in amount) || date.row !== 0 || amount.row !== 0) return null;
  const text = (id: number, selector: Exclude<ColumnSelector, null>) => {
    if (!('row' in selector)) return '';
    const raw = registry.cells[registry.rows[id]?.cells[selector.col - 1]]?.text || '';
    return selector.line === undefined ? raw : raw.split(/\r?\n|\\n/)[selector.line] || '';
  };
  const begins = (id: number) => Boolean(dateFromSource(text(id, date))) && ![null, ''].includes(moneyFromSource(text(id, amount)));
  const groups: number[][] = [];
  for (let i = 0; i < expected.length; i += 2) {
    if (!begins(expected[i].id) || begins(expected[i + 1].id)) return null;
    groups.push([expected[i].id, expected[i + 1].id]);
  }
  const overrides = [];
  for (const item of table.overrides || []) {
    if (groups.some(group => group[0] === item.firstRow)) { overrides.push(item); continue; }
    // An invalid partition can prompt an unnecessary row-offset override. Drop it
    // only when it changes offsets alone; a genuinely different column must stop repair.
    if (!Object.entries(item.fields).every(([field, selector]) => {
      const base = table.fields[field];
      return selector && base && 'row' in selector && 'row' in base
        && selector.col === base.col && selector.line === base.line;
    })) return null;
  }
  return { groups, overrides, basis: 'EVERY_PRINTED_DATE_AMOUNT_ROW_FOLLOWED_BY_ONE_NON_TRANSACTION_CONTINUATION' };
}

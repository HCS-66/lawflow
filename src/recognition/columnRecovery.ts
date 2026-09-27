import type { SourceRegistry } from './sourceAssembly';
import type { MappedTable, ColumnSelector } from './tableMapping';

/** An omitted mapping can be recovered from a unique literal label, never from values alone. */
export function recoverDescriptionColumn(table: MappedTable, registry: SourceRegistry): { selector: ColumnSelector; sources: number[]; basis: string } | null {
  if (table.kind !== 'transactions' || table.fields.description || !table.groups.length || table.groups.some(g => g.length !== 1)) return null;
  const headers = table.ignored.filter(i => i.kind === 'header').flatMap(i => i.r).map(id => registry.rows[id]).filter(Boolean);
  const direct = headers.flatMap(header => header.cells.flatMap((id, col) =>
    /^(?:交易摘要|摘要|交易说明|用途)$/.test(registry.cells[id].text.replace(/\s/g, '')) ? [{ id, col: col + 1 }] : []));
  if (new Set(direct.map(d => d.col)).size === 1) return { selector: { row: 0, col: direct[0].col }, sources: direct.map(d => d.id), basis: 'UNIQUE_LITERAL_DESCRIPTION_HEADER' };
  const tableNumbers = new Set(Object.values(registry.rows).filter(r => r.page === table.page).map(r => r.table));
  const detached = Object.values(registry.cells).filter(c => c.page === table.page && c.row === null
    && /^(?:交易摘要|摘要|交易说明|用途)$/.test(c.text.trim()));
  if (tableNumbers.size === 1 && headers.length === 1 && detached.length === 1) {
    const width = headers[0].cells.length;
    if (table.groups.every(group => registry.rows[group[0]].cells.length === width + 1)) {
      return { selector: { row: 0, col: width + 1 }, sources: [detached[0].id], basis: 'DETACHED_DESCRIPTION_HEADER_AND_EXACTLY_ONE_EXTRA_COLUMN_IN_EVERY_ROW' };
    }
  }
  return null;
}

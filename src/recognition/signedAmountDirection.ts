import type { AssembledRow, SourceRegistry } from './sourceAssembly';
import { moneyFromSource } from './sourceAssembly';
import { alignIndependentRows, independentValues, type IndependentPage } from './independentComparison';
import type { TableMappingPlan } from './tableMapping';

/** An unsigned positive is income only in a corroborated signed deposit amount column. */
export function recoverSignedIncome(rows: AssembledRow[], mapping: TableMappingPlan, registry: SourceRegistry,
  independent: Record<number, IndependentPage>): number[] {
  const recovered: number[] = [];
  for (const table of mapping.tables) {
    const selector = table.fields.amount;
    const reading = independent[table.page];
    if (table.kind !== 'transactions' || table.accountKind !== 'deposit' || !selector || !('row' in selector)
      || !reading || reading.coverage !== 'complete' || reading.pageIssues.length) continue;
    const labels = table.ignored.filter(i => i.kind === 'header').flatMap(i => i.r)
      .map(id => registry.cells[registry.rows[id]?.cells[selector.col - 1]]?.text.replace(/\s/g, '') || '');
    if (!labels.some(s => /^(?:交易金额|发生额|发生金额|交易发生额)$/.test(s))) continue;
    const located = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.sourceRows.some(id => {
      const source = registry.rows[id]; return source.page === table.page && source.table === table.table;
    }));
    const other = reading.rows.map(independentValues);
    const pairs = alignIndependentRows(located.map(x => x.row.values), other).pairs;
    const exact = (left: number, right: number) => [6, 7].every(f => located[left].row.values[f]
      && located[left].row.values[f] === other[right][f])
      && (located[left].row.values[4] === other[right][4]
        || [0, 10].every(f => located[left].row.values[f] && located[left].row.values[f] === other[right][f]))
      && !reading.rows[right].issues.some(i => ['direction', 'amount', 'balance'].includes(i.field));
    const amount = (left: number) => located[left].row.fields[6].length === 1
      ? moneyFromSource(located[left].row.fields[6][0].text) : null;
    // One negative amount independently read as a debit establishes the column convention.
    if (!pairs.some(({ left, right }) => exact(left, right) && amount(left)?.startsWith('-')
      && located[left].row.values[5] === 'OUT' && other[right][5] === 'OUT')) continue;
    for (const { left, right } of pairs) {
      const printed = amount(left), row = located[left].row;
      if (!row.values[5] && printed && /^\d+\.\d{2}$/.test(printed) && printed !== '0.00'
        && exact(left, right) && other[right][5] === 'IN') recovered.push(located[left].index);
    }
  }
  return recovered;
}

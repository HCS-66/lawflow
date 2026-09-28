import type { AssembledRow, SourceRegistry } from './sourceAssembly';
import type { MappedTable } from './tableMapping';
import { semanticText } from './semanticText';

/** Some transcriptions put a literal business label in the merchant column.
 * Only complete, unambiguous labels qualify; merchant names and substrings do not.
 */
export function auxiliaryPrintedPurpose(row: AssembledRow, table: MappedTable, registry: SourceRegistry) {
  if (row.values[8] || table.accountKind !== 'deposit' || row.sourceRows.length !== 1) return null;
  const headers = table.ignored.filter(h => h.kind === 'header').flatMap(h => h.r).map(id => registry.rows[id]).filter(Boolean);
  const columns = new Set(headers.flatMap(h => h.cells.flatMap((id, col) =>
    /^(?:商户名称|商户简称|交易商户)$/.test(semanticText(registry.cells[id].text)) ? [col] : [])));
  if (columns.size !== 1) return null;
  const sourceRow = registry.rows[row.sourceRows[0]], cell = registry.cells[sourceRow?.cells[[...columns][0]]];
  if (!cell) return null;
  const label = semanticText(cell.text), direction = row.values[5];
  const type = direction === 'IN' && label === '代发工资' ? '工资收入'
    : direction === 'IN' && label === '银联入账' ? '第三方支付'
    : (direction === 'IN' && label === '转账收入' || direction === 'OUT' && label === '转账支出') ? '账户转账' : '';
  return type ? { type, cell } : null;
}

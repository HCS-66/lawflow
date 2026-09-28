import { assembleFromSources, type AssemblyPlan, type AssemblyRow, type SourceRegistry, type SourceSelection } from './sourceAssembly';
import { selectSourceLine, selectSourceParty } from './sourceFragments';
import { repairUniformRowGroups } from './rowGrouping';
import { recoverDescriptionColumn, combinedPartyColumn } from './columnRecovery';
import { semanticText } from './semanticText';

export type ColumnSelector = null | { row: number; col: number; line?: number; part?: 'account' | 'name' } | { fixed: number; text?: string };
export interface MappedTable {
  page: number; table: number; kind: string; accountKind: 'deposit' | 'credit' | 'unknown';
  fields: Record<string, ColumnSelector>; directionCodes: Record<string, 'IN' | 'OUT'> | null;
  groups: number[][]; ignored: AssemblyPlan['ignored'];
  overrides?: Array<{ firstRow: number; fields: Record<string, ColumnSelector> }>;
}
export interface TableMappingPlan { tables: MappedTable[]; typeRules: Array<{ accountKind: string; text: string; type: string }> }

export function materializeTableMapping(mapping: TableMappingPlan, registry: SourceRegistry) {
  if (!Array.isArray(mapping.tables) || !Array.isArray(mapping.typeRules)) throw new Error('Invalid table mapping');
  const plan: AssemblyPlan = { rows: [], ignored: [] };
  const metadata: Array<{ page: number; table: number; order: number; accountKind: string; description: string; directOwner: boolean }> = [];
  const seenTables = new Set<string>();
  const roleCorrections: Array<{ page: number; table: number; field: string; reason: string }> = [];
  const groupCorrections: Array<{ page: number; table: number; before: number[][]; after: number[][]; basis: string }> = [];
  const columnCorrections: Array<{ page: number; table: number; field: string; sources: number[]; basis: string }> = [];
  const fragmentFailures: Array<{ outputRow: number; sourceRows: number[]; cell: number; part: 'account' | 'name' }> = [];
  const keys = ['accountNumber', 'accountName', 'bankName', 'transactionTime', 'transactionDate', 'direction', 'amount',
    'balance', 'description', 'counterpartyName', 'counterpartyAccount', 'counterpartyBank'];
  const cellText = (selection: SourceSelection | undefined) => selection === undefined ? '' : typeof selection === 'number'
    ? registry.cells[selection]?.text || '' : selection.text;
  for (const original of mapping.tables) {
    if (!Array.isArray(original.groups) || !Array.isArray(original.ignored) || !original.fields) throw new Error('Malformed table mapping');
    const repair = repairUniformRowGroups(original, registry);
    const table = repair ? { ...original, groups: repair.groups, overrides: repair.overrides } : original;
    if (repair) groupCorrections.push({ page: table.page, table: table.table, before: original.groups, after: repair.groups, basis: repair.basis });
    const tableKey = `${table.page}:${table.table}`;
    if (seenTables.has(tableKey)) throw new Error('Duplicate table mapping');
    seenTables.add(tableKey);
    if (!Array.isArray(table.groups) || !Array.isArray(table.ignored) || !table.fields) throw new Error('Malformed table mapping');
    const safeFields = { ...table.fields };
    const partyColumn = combinedPartyColumn(table, registry);
    if (partyColumn !== null) {
      for (const [field, part] of [['counterpartyAccount', 'account'], ['counterpartyName', 'name']] as const) {
        const selected = safeFields[field];
        if (!selected || ('row' in selected && selected.row === 0 && selected.col === partyColumn && selected.line === undefined)) {
          safeFields[field] = { row: 0, col: partyColumn, part };
          columnCorrections.push({ page: table.page, table: table.table, field, sources: [], basis: 'EXPLICIT_COMBINED_PARTY_HEADER' });
        }
      }
    }
    const descriptionRecovery = recoverDescriptionColumn(table, registry);
    if (descriptionRecovery) {
      safeFields.description = descriptionRecovery.selector;
      columnCorrections.push({ page: table.page, table: table.table, field: 'description', sources: descriptionRecovery.sources, basis: descriptionRecovery.basis });
    }
    const headerRows = table.ignored.filter(item => item.kind === 'header').flatMap(item => item.r)
      .map(id => registry.rows[id]).filter(Boolean);
    for (const [own, other] of [['accountNumber', 'counterpartyAccount'], ['accountName', 'counterpartyName'], ['bankName', 'counterpartyBank']]) {
      const selector = safeFields[own];
      if (!selector || !('row' in selector)) continue;
      const sameCounterpartyColumn = table.fields[other] && JSON.stringify(selector) === JSON.stringify(table.fields[other]);
      const header = headerRows[selector.row] || (headerRows.length === 1 ? headerRows[0] : undefined);
      const label = header ? registry.cells[header.cells[selector.col - 1]]?.text.replace(/\s/g, '') || '' : '';
      if (sameCounterpartyColumn || /^(?:对方|交易对手|收款方|付款方)/.test(label)) {
        safeFields[own] = null;
        roleCorrections.push({ page: table.page, table: table.table, field: own, reason: 'Owner field selected an explicitly counterparty column' });
      }
    }
    plan.ignored.push(...table.ignored);
    if (table.kind !== 'transactions') {
      if (!['account', 'other'].includes(table.kind)) throw new Error('Unknown table kind');
      for (const group of table.groups) {
        if (!group.length || !group.every(id => registry.rows[id]?.page === table.page && registry.rows[id]?.table === table.table)) {
          throw new Error('Nontransaction group references another table');
        }
        plan.ignored.push({ r: group, kind: table.kind as 'account' | 'other' });
      }
      continue;
    }
    for (const group of table.groups) {
      if (!group.length || !group.every(id => registry.rows[id]?.page === table.page && registry.rows[id]?.table === table.table)) throw new Error('Group references another table');
      const pick = (selector: ColumnSelector | undefined): SourceSelection[] => {
        if (!selector) return [];
        if ('fixed' in selector) return [selector.text === undefined ? selector.fixed : { id: selector.fixed, text: selector.text }];
        if (!Number.isInteger(selector.row) || selector.row < 0 || !Number.isInteger(selector.col) || selector.col < 1) throw new Error('Invalid column mapping');
        const row = registry.rows[group[selector.row]];
        const cell = row?.cells[selector.col - 1];
        if (selector.part !== undefined) {
          if (selector.line !== undefined) throw new Error('Party selector cannot also select a line');
          if (cell === undefined) return [];
          const selected = selectSourceParty(registry.cells[cell], selector.part);
          if (selected === null) fragmentFailures.push({ outputRow: plan.rows.length + 1, sourceRows: group, cell, part: selector.part });
          return selected || [];
        }
        return cell === undefined ? [] : selectSourceLine(registry.cells[cell], selector.line);
      };
      const overrides = (table.overrides || []).filter(item => item.firstRow === group[0]);
      if (overrides.length > 1 || (table.overrides || []).some(item => !table.groups.some(g => g[0] === item.firstRow))) throw new Error('Invalid or duplicate row override');
      const effectiveFields = { ...safeFields, ...(overrides[0]?.fields || {}) };
      for (const [own, other] of [['accountNumber', 'counterpartyAccount'], ['accountName', 'counterpartyName'], ['bankName', 'counterpartyBank']]) {
        const selector = effectiveFields[own];
        if (!selector || !('row' in selector)) continue;
        const header = headerRows[selector.row] || (headerRows.length === 1 ? headerRows[0] : undefined);
        const label = header ? registry.cells[header.cells[selector.col - 1]]?.text.replace(/\s/g, '') || '' : '';
        if ((effectiveFields[other] && JSON.stringify(selector) === JSON.stringify(effectiveFields[other]))
          || /^(?:对方|交易对手|收款方|付款方)/.test(label)) {
          effectiveFields[own] = null;
          roleCorrections.push({ page: table.page, table: table.table, field: own, reason: 'Row override selected a counterparty column for the owner' });
        }
      }
      const f = keys.map(key => pick(effectiveFields[key]));
      // Date and time are composed from their separate printed cells.
      f[3] = [...f[4], ...f[3].filter(s => !f[4].some(d => JSON.stringify(s) === JSON.stringify(d)))];
      const description = semanticText(cellText(f[8][0]));
      const descriptions = new Set([description]);
      const namedTypeColumns = new Set(headerRows.flatMap(header => header.cells.flatMap((id, col) =>
        /^(?:交易类型|业务类型|交易名称|交易摘要|摘要|摘要描述|扩展用途|用途|交易备注|附言|交易地点[\/／]附言)$/.test(semanticText(registry.cells[id].text)) ? [col] : [])));
      for (const col of namedTypeColumns) {
        for (const sourceRow of group) {
          const cell = registry.cells[registry.rows[sourceRow].cells[col]];
          if (cell?.text.trim()) {
            descriptions.add(semanticText(cell.text));
            if (!f[8].some(s => (typeof s === 'number' ? s : s.id) === cell.id)) f[8].push(cell.id);
          }
        }
      }
      const rules = mapping.typeRules.filter(rule => descriptions.has(semanticText(rule.text)) && (rule.accountKind === table.accountKind || rule.accountKind === 'any'));
      const types = new Set(rules.map(rule => rule.type));
      const rawDirection = cellText(f[5][0]).trim();
      const item: AssemblyRow = { r: group, f, d: table.directionCodes?.[rawDirection] || '', t: types.size === 1 ? [...types][0] : '' };
      plan.rows.push(item);
      metadata.push({ page: table.page, table: table.table, order: registry.rows[group[0]].row,
        accountKind: table.accountKind, description, directOwner: Boolean(effectiveFields.accountNumber && 'row' in effectiveFields.accountNumber) });
    }
  }
  const expectedTables = new Set(Object.values(registry.rows).map(row => `${row.page}:${row.table}`));
  if ([...expectedTables].some(key => !seenTables.has(key)) || [...seenTables].some(key => !expectedTables.has(key))) throw new Error('Table coverage incomplete or invented');
  const result = assembleFromSources(plan, registry);
  for (const failure of fragmentFailures) result.issues.push({ id: `PARTY_FRAGMENT_${failure.outputRow}_${failure.part}`, code: 'AMBIGUOUS_PARTY_FRAGMENT',
    field: failure.part === 'account' ? 'counterpartyAccount' : 'counterpartyName', severity: 'REQUIRED', outputRows: [failure.outputRow],
    sourceRows: failure.sourceRows, sourceCells: [failure.cell], message: '同格账号与户名无法可靠拆分，请核对原文片段' });
  return { ...result, metadata, plan, roleCorrections, groupCorrections, columnCorrections };
}

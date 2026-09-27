import { accountFromSource, dateFromSource, moneyFromSource, type AssembledRow, type SourceRegistry } from './sourceAssembly';
import type { TableMappingPlan } from './tableMapping';
import type { IndependentPage } from './independentComparison';
import type { FocusedAccounts } from './accountRecovery';

/** Bind a printed local account to its full account-list entry, retaining both identities. */
export function assessAccountInventory(rows: AssembledRow[], mapping: TableMappingPlan, registry: SourceRegistry,
  independent: Record<number, IndependentPage>, focused: Record<number, FocusedAccounts> = {}) {
  const inventory: Array<{ account: string; owner: string; balance: string; date: string; sources: string[]; sourceRow: number; verified: boolean }> = [];
  for (const table of mapping.tables.filter(t => t.kind === 'account')) {
    const sourceRows = Object.values(registry.rows).filter(r => r.page === table.page && r.table === table.table);
    for (const header of sourceRows) {
      const labels = header.cells.map(id => registry.cells[id].text.replace(/\s/g, ''));
      const a = labels.findIndex(t => /^(?:账号|账户号|账户账号|客户账号)$/.test(t));
      const n = labels.findIndex(t => /^(?:客户名称|姓名|户名|账户名称)$/.test(t));
      const b = labels.findIndex(t => /^(?:余额|账户余额|金额)$/.test(t));
      const d = labels.findIndex(t => /^(?:数据日期|查询日期|截止日期)$/.test(t));
      if ([a, n, b, d].some(i => i < 0)) continue;
      for (const source of sourceRows.filter(r => r.row > header.row)) {
        const text = (col: number) => registry.cells[source.cells[col]]?.text || '';
        const account = accountFromSource(text(a)), balance = moneyFromSource(text(b)), date = dateFromSource(text(d));
        if (!account || !/^\d{12,32}$/.test(account) || !balance || !date || !text(n).trim()) continue;
        const ordinarySupport = independent[table.page]?.ownerIdentifiers?.some(id => id.role === 'account' && id.value === account);
        const focusedSupport = focused[table.page]?.issues.length === 0 && focused[table.page].identifiers.some(id =>
          id.role === 'account' && id.scope === 'account_information' && id.table === table.table && id.value === account
          && id.characters.join('') === account && id.uncertainPositions.length === 0);
        inventory.push({ account, owner: text(n).trim(), balance, date,
          sourceRow: source.id, verified: Boolean(ordinarySupport || focusedSupport),
          sources: [`primary:row:${source.id}`, ...(ordinarySupport ? [`independent:p${table.page}:ownerIdentifiers`] : []),
            ...(focusedSupport ? [`focused:p${table.page}:table${table.table}:account_information`] : [])] });
      }
    }
  }
  const groups = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const key = JSON.stringify([row.values[0], row.values[1]]);
    groups.set(key, [...(groups.get(key) || []), i]);
  });
  const bindings: Array<{ from: string; to: string; owner: string; observations: number[]; sources: string[] }> = [];
  const unresolved: Array<{ from: string; candidates: string[]; observations: number[]; sourceRows: number[]; reason: string }> = [];
  for (const indices of groups.values()) {
    const first = rows[indices[0]], account = first.values[0], owner = first.values[1];
    if (!/^\d{12,28}$/.test(account) || !owner || inventory.some(i => i.account === account)) continue;
    const ordered = indices.map(i => rows[i]).filter(r => r.values[4] && r.values[7]).sort((a, b) => a.values[4].localeCompare(b.values[4]));
    const last = ordered[ordered.length - 1];
    if (!last || ordered.length < 2) continue;
    const candidates = inventory.filter(i => i.owner === owner && i.account.endsWith(account)
      && i.account.length > account.length && i.account.length - account.length <= 4
      && i.balance === last.values[7] && i.date >= last.values[4]);
    const choices = new Set(candidates.map(c => c.account));
    const pageNumbers = new Set(indices.flatMap(i => rows[i].sourceRows.map(r => registry.rows[r].page)));
    const independentSupport = [...pageNumbers].flatMap(page => independent[page]?.rows || [])
      .filter(row => accountFromSource(row.values[0]) === account);
    if (!choices.size) continue;
    if (choices.size !== 1 || independentSupport.length < 2 || !candidates.some(c => c.verified)) {
      unresolved.push({ from: account, candidates: [...choices], observations: indices.map(i => i + 1),
        sourceRows: [...new Set([...candidates.map(c => c.sourceRow), ...indices.flatMap(i => rows[i].sourceRows)])],
        reason: choices.size !== 1 ? 'MULTIPLE_FULL_ACCOUNT_CANDIDATES' : 'FULL_ACCOUNT_NOT_INDEPENDENTLY_CONFIRMED' });
      continue;
    }
    const target = [...choices][0];
    bindings.push({ from: account, to: target, owner, observations: indices.map(i => i + 1),
      sources: [...new Set(candidates.flatMap(c => c.sources)), ...[...pageNumbers].map(p => `independent:p${p}:printedLocalAccount`)] });
  }
  return { bindings, unresolved };
}

export function bindAccountInventory(rows: AssembledRow[], mapping: TableMappingPlan, registry: SourceRegistry,
  independent: Record<number, IndependentPage>) {
  return assessAccountInventory(rows, mapping, registry, independent).bindings;
}

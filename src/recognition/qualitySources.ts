import type { VerbatimPage } from './qualityProtocol';
import type { SourceRegistry } from './sourceAssembly';
import type { TableMappingPlan, ColumnSelector } from './tableMapping';

/** Identical cell/row numbering to experimentSourceAssembly.py; no document answers. */
export function buildQualitySources(pages: VerbatimPage[]) {
  const registry: SourceRegistry = { cells: {}, rows: {}, pages: pages.map((_, i) => i + 1) };
  let cellId = 1, rowId = 1;
  const source = pages.map((p, i) => {
    const page = i + 1;
    const h = p.nearTableText.map(text => {
      const id = cellId++;
      registry.cells[id] = { id, text, page, row: null, column: null };
      return [id, text];
    });
    const tables = p.tables.map((t, tableIndex) => t.rows.map((c, r) => {
      const id = rowId++, b = cellId;
      const cells = c.map((text, column) => {
        const cell = cellId++;
        registry.cells[cell] = { id: cell, text, page, row: id, column: column + 1 };
        return cell;
      });
      registry.rows[id] = { id, page, table: tableIndex + 1, row: r + 1, cells };
      return { id, b, c };
    }));
    return { page, h, tables };
  });
  return { registry, source };
}

/** Rebase stable selectors after a source reread, preserving established mappings on unchanged pages. */
export function stabilizeQualityMapping(old: TableMappingPlan, latest: TableMappingPlan, before: SourceRegistry, after: SourceRegistry): TableMappingPlan {
  if (JSON.stringify(before.pages) !== JSON.stringify(after.pages)) throw new Error('重读不能改变页面目录');
  const index = (registry: SourceRegistry) => {
    const rows = new Map(Object.values(registry.rows).map(r => [r.id, JSON.stringify([r.page, r.table, r.row])]));
    const cells = new Map<number, string>(), content = new Map<number, string[]>(), counts = new Map<string, number>();
    for (const cell of Object.values(registry.cells).sort((a, b) => a.id - b.id)) {
      const base = [cell.page, rows.get(cell.row!) || null, cell.column, cell.text];
      const k = JSON.stringify(base), n = counts.get(k) || 0; counts.set(k, n + 1);
      cells.set(cell.id, JSON.stringify([...base, n]));
      content.set(cell.page, [...(content.get(cell.page) || []), JSON.stringify([...base.slice(1), n])]);
    }
    return { rows, cells, content };
  };
  const a = index(before), b = index(after);
  const rowLookup = new Map([...b.rows].map(([id, k]) => [k, id]));
  const cellLookup = new Map([...b.cells].map(([id, k]) => [k, id]));
  const row = (id: number) => { const value = rowLookup.get(a.rows.get(id)!); if (!value) throw new Error('Missing source row'); return value; };
  const field = (s: ColumnSelector) => {
    if (!s || !('fixed' in s)) return s;
    const fixed = cellLookup.get(a.cells.get(s.fixed)!); if (!fixed) throw new Error('Missing source cell'); return { ...s, fixed };
  };
  const fields = (v: Record<string, ColumnSelector>) => Object.fromEntries(Object.entries(v).map(([k, s]) => [k, field(s)]));
  const tables = latest.tables.map(t => {
    const prior = old.tables.find(p => p.page === t.page && p.table === t.table);
    if (!prior || JSON.stringify(a.content.get(t.page)) !== JSON.stringify(b.content.get(t.page))) return t;
    try { return { ...prior, fields: fields(prior.fields), groups: prior.groups.map(g => g.map(row)),
      ignored: prior.ignored.map(v => ({ ...v, r: v.r.map(row) })),
      overrides: prior.overrides?.map(v => ({ firstRow: row(v.firstRow), fields: fields(v.fields) })) }; }
    catch { return t; }
  });
  const typeRules = structuredClone(old.typeRules);
  const ruleKey = (r: typeof typeRules[number]) => JSON.stringify([r.accountKind, r.text.replace(/\\n|\s/g, '')]);
  const seen = new Set(typeRules.map(ruleKey));
  for (const rule of latest.typeRules) if (!seen.has(ruleKey(rule))) { typeRules.push(rule); seen.add(ruleKey(rule)); }
  return { tables, typeRules };
}

import type { AssembledRow, AssemblyIssue, SourceRegistry, StatementColumn } from './sourceAssembly';
import { STATEMENT_COLUMNS, accountFromSource, dateFromSource, moneyFromSource } from './sourceAssembly';

export interface IndependentRow {
  row: number;
  values: string[];
  rawDirection: string;
  issues: Array<{ field: StatementColumn; kind: string; reason: string }>;
}
export interface IndependentPage {
  pageType: string; coverage: string; pageIssues: string[]; rows: IndependentRow[];
  bankName?: string;
  ownerNames?: string[];
  ownerIdentifiers?: Array<{ role: string; value: string }>;
}
export const KEY_READER_COLUMNS = [0, 4, 3, 5, 6, 7, 9, 10] as const;
export function independentValues(row: IndependentRow): string[] {
  const values = Array.from({ length: 12 }, () => '');
  for (let i = 0; i < KEY_READER_COLUMNS.length; i++) values[KEY_READER_COLUMNS[i]] = row.values[i];
  for (const field of [0, 10]) values[field] = accountFromSource(values[field]) ?? values[field];
  values[4] = dateFromSource(values[4]) ?? values[4];
  if (['+', '收入', '转入', '贷', '贷方'].includes(values[5])) values[5] = 'IN';
  if (['-', '支出', '转出', '借', '借方'].includes(values[5])) values[5] = 'OUT';
  for (const field of [6, 7]) values[field] = moneyFromSource(values[field], field === 6) ?? values[field];
  values[3] = values[4] ? values[4] + (values[3] ? ` ${values[3]}` : '') : '';
  return values;
}

function matchingScore(left: string[], right: string[]): number | null {
  let agrees = 0, score = 0;
  for (const [field, weight] of [[0, 3], [4, 2], [5, 1], [6, 3], [7, 3], [10, 2]]) {
    if (!left[field] || !right[field]) continue;
    if (left[field] === right[field]) { agrees++; score += weight; }
    else score -= 1;
  }
  return agrees >= 3 && score >= 4 ? score : null;
}

/** Ordered alignment with gaps. Only pairs shared by every optimum are accepted. */
export function alignIndependentRows(left: string[][], right: string[][]) {
  const n = left.length, m = right.length, gap = -4;
  const forward = Array.from({ length: n + 1 }, () => Array(m + 1).fill(-Infinity));
  const backward = Array.from({ length: n + 1 }, () => Array(m + 1).fill(-Infinity));
  const scores = left.map(a => right.map(b => matchingScore(a, b)));
  forward[0][0] = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    if (i < n) forward[i + 1][j] = Math.max(forward[i + 1][j], forward[i][j] + gap);
    if (j < m) forward[i][j + 1] = Math.max(forward[i][j + 1], forward[i][j] + gap);
    if (i < n && j < m && scores[i][j] !== null) forward[i + 1][j + 1] = Math.max(forward[i + 1][j + 1], forward[i][j] + scores[i][j]!);
  }
  backward[n][m] = 0;
  for (let i = n; i >= 0; i--) for (let j = m; j >= 0; j--) {
    if (i < n) backward[i][j] = Math.max(backward[i][j], gap + backward[i + 1][j]);
    if (j < m) backward[i][j] = Math.max(backward[i][j], gap + backward[i][j + 1]);
    if (i < n && j < m && scores[i][j] !== null) backward[i][j] = Math.max(backward[i][j], scores[i][j]! + backward[i + 1][j + 1]);
  }
  const optimum = forward[n][m];
  const leftOptions = Array.from({ length: n }, () => new Set<number>());
  const rightOptions = Array.from({ length: m }, () => new Set<number>());
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    if (i < n && forward[i][j] + gap + backward[i + 1][j] === optimum) leftOptions[i].add(-1);
    if (j < m && forward[i][j] + gap + backward[i][j + 1] === optimum) rightOptions[j].add(-1);
    if (i < n && j < m && scores[i][j] !== null && forward[i][j] + scores[i][j]! + backward[i + 1][j + 1] === optimum) {
      leftOptions[i].add(j); rightOptions[j].add(i);
    }
  }
  const pairs: Array<{ left: number; right: number }> = [];
  leftOptions.forEach((options, i) => {
    const j = [...options][0];
    if (options.size === 1 && j >= 0 && rightOptions[j].size === 1) pairs.push({ left: i, right: j });
  });
  return { pairs, unmatchedLeft: leftOptions.flatMap((_, i) => pairs.some(p => p.left === i) ? [] : [i]),
    unmatchedRight: rightOptions.flatMap((_, j) => pairs.some(p => p.right === j) ? [] : [j]) };
}

export function compareIndependentReadings(rows: AssembledRow[], registry: SourceRegistry,
  pages: Record<number, IndependentPage>, numericDirectionCodes: Record<string, Record<string, string>> = {},
  explicitSingleAccountTables: Record<string, string> = {}, combinedCounterpartyTables: Set<string> = new Set(),
  contextualDirections: Record<number, string> = {}) {
  const pairs: Array<{ outputRow: number; page: number; independentRow: number; values: string[]; directionBasis: string; accountBasis: string }> = [];
  const issues: AssemblyIssue[] = [];
  let activePage = 0;
  const add = (code: string, field: StatementColumn | null, outputRows: number[], sourceRows: number[], message: string) => {
    issues.push({ id: `IR${issues.length + 1}`, code, field, outputRows, sourceRows, sourceCells: [], sourcePages: [activePage], severity: 'REQUIRED', message });
  };
  for (const pageNumber of registry.pages) {
    activePage = pageNumber;
    const page = pages[pageNumber];
    const located = rows.map((row, i) => ({ row, number: i + 1 })).filter(item => item.row.sourceRows.some(id => registry.rows[id]?.page === pageNumber))
      .sort((a, b) => {
        const first = (row: AssembledRow) => Math.min(...row.sourceRows.filter(id => registry.rows[id]?.page === pageNumber)
          .map(id => registry.rows[id].table * 100000 + registry.rows[id].row));
        return first(a.row) - first(b.row);
      });
    if (!page || page.coverage !== 'complete' || page.pageIssues.length) {
      add('INDEPENDENT_PAGE_INCOMPLETE', null, located.map(r => r.number), located.flatMap(r => r.row.sourceRows), `第${pageNumber}页独立读取未确认覆盖完整`);
    }
    if (!page) continue;
    const other = page.rows.map(independentValues);
    const alignment = alignIndependentRows(located.map(r => r.row.values), other);
    const independentAccountByTable = new Map<string, Set<string>>();
    for (const pair of alignment.pairs) {
      const source = registry.rows[located[pair.left].row.sourceRows[0]], key = `${source.page}:${source.table}`;
      const values = independentAccountByTable.get(key) || new Set<string>();
      if (other[pair.right][0]) values.add(other[pair.right][0]);
      independentAccountByTable.set(key, values);
    }
    for (const pair of alignment.pairs) {
      const own = located[pair.left], alt = other[pair.right], observed = page.rows[pair.right];
      let directionBasis = 'INDEPENDENT_SEMANTIC_VALUE';
      const firstSource = registry.rows[own.row.sourceRows[0]];
      const tableKey = `${firstSource.page}:${firstSource.table}`;
      if (combinedCounterpartyTables.has(tableKey) && !alt[10]) {
        const combined = alt[9].match(/^([^\d]+)(\d{4})$/);
        if (combined && !/存款应(?:计)?付利息/.test(combined[1])) { alt[9] = combined[1]; alt[10] = `尾号${combined[2]}`; }
      }
      const ownAccount = explicitSingleAccountTables[tableKey], observedAccounts = independentAccountByTable.get(tableKey);
      let accountBasis = 'INDEPENDENT_PRINTED_VALUE';
      if (!alt[0] && ownAccount && observedAccounts?.size === 1 && observedAccounts.has(ownAccount)
        && !observed.issues.some(i => i.field === 'accountNumber')) {
        alt[0] = ownAccount;
        accountBasis = 'PRINTED_SINGLE_ACCOUNT_COLUMN_WITH_INDEPENDENT_SAME_TABLE_SUPPORT';
      }
      const codes = numericDirectionCodes[`${firstSource.page}:${firstSource.table}`] || {};
      const marker = observed.rawDirection.trim();
      if (!alt[5] && own.row.fields[5].some(s => s.text.trim() === marker) && ['IN', 'OUT'].includes(codes[marker])) {
        // Checks printed symbols independently; semantics remain an explicit, testable mapping rule.
        alt[5] = codes[marker];
        directionBasis = 'INDEPENDENT_RAW_MARKER_WITH_DECLARED_COLUMN_MAPPING';
      }
      if (!alt[5] && !marker && contextualDirections[own.number]) {
        alt[5] = contextualDirections[own.number];
        directionBasis = 'PRINTED_DEPOSIT_DIRECTION_WITH_EXACT_BALANCE_SEQUENCE';
      }
      pairs.push({ outputRow: own.number, page: pageNumber, independentRow: observed.row, values: alt, directionBasis, accountBasis });
      const compared = [0, 4, 5, 6, 7, 10, ...(!own.row.values[10] && !alt[10] ? [9] : [])];
      for (const field of compared) if (own.row.values[field] !== alt[field]) add('INDEPENDENT_VALUE_CONFLICT', STATEMENT_COLUMNS[field], [own.number], own.row.sourceRows,
        `第${pageNumber}页第${observed.row}笔的${STATEMENT_COLUMNS[field]}在两条读取路径中不一致`);
      for (const doubt of observed.issues) if (compared.includes(STATEMENT_COLUMNS.indexOf(doubt.field))) {
        add('INDEPENDENT_SOURCE_UNCERTAIN', doubt.field, [own.number], own.row.sourceRows, `第${pageNumber}页第${observed.row}笔：${doubt.reason}`);
      }
    }
    for (const i of alignment.unmatchedLeft) add('INDEPENDENT_ROW_UNMATCHED', null, [located[i].number], located[i].row.sourceRows,
      `第${pageNumber}页该笔无法与独立读取唯一对应`);
    for (const j of alignment.unmatchedRight) add('INDEPENDENT_EXTRA_OBSERVATION', null, [],
      Object.values(registry.rows).filter(r => r.page === pageNumber).map(r => r.id),
      `第${pageNumber}页独立读取的第${page.rows[j].row}笔未找到唯一对应；需检查遗漏范围`);
  }
  return { pairs, issues };
}

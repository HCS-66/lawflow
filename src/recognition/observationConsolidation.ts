import type { AssembledRow } from './sourceAssembly';
import { alignIndependentRows } from './independentComparison';

export interface ObservationContext {
  page: number; table: number; order: number; accountKind: string; description: string; directOwner: boolean;
}
export interface ConsolidatedEvent {
  id: string; representative: number; observations: number[]; values: string[];
  conflicts: Array<{ field: number; values: string[]; observations: number[] }>;
}

/** Consolidate only source streams with a substantial unique transaction overlap. */
export function consolidateObservations(rows: AssembledRow[], context: ObservationContext[], independentByObservation: Record<number, string[]> = {}) {
  if (rows.length !== context.length) throw new Error('Observation context length mismatch');
  const streamKey = (i: number) => `${rows[i].values[0]}|${context[i].directOwner ? 'ROW_OWNER' : 'HEADER_OWNER'}|${context[i].accountKind}`;
  const streams = new Map<string, number[]>();
  rows.forEach((_, i) => streams.set(streamKey(i), [...(streams.get(streamKey(i)) || []), i]));
  const key = (i: number, fields = [4, 5, 6, 7]) => fields.every(f => rows[i].values[f] !== '')
    ? JSON.stringify(fields.map(f => rows[i].values[f])) : '';
  const uniqueIndex = (indices: number[]) => {
    const m = new Map<string, number[]>();
    for (const i of indices) { const k = key(i); if (k) m.set(k, [...(m.get(k) || []), i]); }
    return m;
  };
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : parent[i] = find(parent[i]);
  const union = (a: number, b: number) => {
    const x = find(a), y = find(b);
    if (x === y) return;
    // Never collapse two observations from the same source stream.
    const left = new Set(rows.flatMap((_, i) => find(i) === x ? [streamKey(i)] : []));
    if (rows.some((_, i) => find(i) === y && left.has(streamKey(i)))) return;
    parent[y] = x;
  };
  const links: Array<{ leftStream: string; rightStream: string; anchors: number; distinctDates: number;
    matches: Array<{ left: number; right: number; basis: string }> }> = [];
  const entries = [...streams.entries()];
  for (let a = 0; a < entries.length; a++) for (let b = a + 1; b < entries.length; b++) {
    const [ka, ia] = entries[a], [kb, ib] = entries[b];
    if (context[ia[0]].accountKind !== context[ib[0]].accountKind) continue;
    if (context[ia[0]].directOwner === context[ib[0]].directOwner) continue;
    const ma = uniqueIndex(ia), mb = uniqueIndex(ib);
    const anchors: Array<{ left: number; right: number; basis: string }> = [];
    for (const [k, left] of ma) {
      const right = mb.get(k);
      if (left.length === 1 && right?.length === 1) anchors.push({ left: left[0], right: right[0], basis: 'EXACT_DATE_DIRECTION_AMOUNT_BALANCE' });
    }
    const dates = new Set(anchors.map(p => rows[p.left].values[4]));
    if (anchors.length < 3 || dates.size < 2 || anchors.length / Math.min(ia.length, ib.length) < .8) continue;
    const matches = [...anchors];
    const usedA = new Set(anchors.map(p => p.left)), usedB = new Set(anchors.map(p => p.right));
    const orderedAnchors = [...anchors].sort((x, y) => ia.indexOf(x.left) - ia.indexOf(y.left));
    let increasing = 0, decreasing = 0;
    for (let k = 1; k < orderedAnchors.length; k++) {
      const delta = ib.indexOf(orderedAnchors[k].right) - ib.indexOf(orderedAnchors[k - 1].right);
      if (delta > 0) increasing++; else if (delta < 0) decreasing++;
    }
    if (Math.max(increasing, decreasing) / Math.max(1, increasing + decreasing) >= .8) {
      const orderedB = decreasing > increasing ? [...ib].reverse() : ib;
      const aligned = alignIndependentRows(ia.map(i => rows[i].values), orderedB.map(i => rows[i].values));
      const pairs = aligned.pairs.map(p => ({ left: ia[p.left], right: orderedB[p.right], basis: 'UNIQUE_ORDERED_ALIGNMENT_PRESERVING_ALL_EXACT_ANCHORS' }));
      if (anchors.every(a => pairs.some(p => p.left === a.left && p.right === a.right))) {
        for (const p of pairs) if (!usedA.has(p.left) && !usedB.has(p.right)) {
          matches.push(p); usedA.add(p.left); usedB.add(p.right);
        }
      }
      // A damaged primary row may disagree in several fields. Independent readings
      // can identify its position, but never replace its printed values here.
      const corroborated = alignIndependentRows(ia.map(i => independentByObservation[i + 1] || rows[i].values),
        orderedB.map(i => independentByObservation[i + 1] || rows[i].values));
      const assisted = corroborated.pairs.map(p => ({ left: ia[p.left], right: orderedB[p.right], basis: 'INDEPENDENT_ORDERED_ALIGNMENT_IN_ESTABLISHED_DUPLICATE_VIEWS' }));
      if (matches.every(a => assisted.some(p => p.left === a.left && p.right === a.right))) {
        for (const p of assisted) if (!usedA.has(p.left) && !usedB.has(p.right)) {
          const x = independentByObservation[p.left + 1], y = independentByObservation[p.right + 1];
          // Date, direction and a cash value must agree independently; matching
          // only owner/counterparty identifiers is insufficient for duplicate identity.
          if (!x || !y || !x[4] || x[4] !== y[4] || !x[5] || x[5] !== y[5]
            || ![6, 7].some(f => x[f] && x[f] === y[f])) continue;
          matches.push(p); usedA.add(p.left); usedB.add(p.right);
        }
      }
    }
    // Weak matches are considered only within two already-established duplicate views.
    const compatible = (i: number, j: number) => {
      const x = rows[i].values, y = rows[j].values;
      if (!x[4] || x[4] !== y[4] || !x[5] || x[5] !== y[5]) return false;
      return [6, 7].some(f => x[f] !== '' && x[f] === y[f]);
    };
    for (const i of ia.filter(i => !usedA.has(i))) {
      const candidates = ib.filter(j => !usedB.has(j) && compatible(i, j));
      if (candidates.length !== 1) continue;
      const j = candidates[0];
      if (ia.filter(k => !usedA.has(k) && compatible(k, j)).length !== 1) continue;
      usedA.add(i); usedB.add(j);
      matches.push({ left: i, right: j, basis: 'UNIQUE_CONFLICT_IN_ESTABLISHED_DUPLICATE_VIEWS' });
    }
    for (const match of matches) union(match.left, match.right);
    links.push({ leftStream: ka, rightStream: kb, anchors: anchors.length, distinctDates: dates.size, matches });
  }
  const grouped = new Map<number, number[]>();
  rows.forEach((_, i) => grouped.set(find(i), [...(grouped.get(find(i)) || []), i]));
  const events: ConsolidatedEvent[] = [...grouped.values()].map((indices, index) => {
    const ranked = [...indices].sort((a, b) => Number(context[b].directOwner) - Number(context[a].directOwner)
      || rows[b].values.filter(Boolean).length - rows[a].values.filter(Boolean).length || a - b);
    const chosen = ranked[0];
    const values = [...rows[chosen].values];
    // Fill only absent values from unanimous observations, retaining all alternatives below.
    for (let field = 0; field < 12; field++) if (!values[field]) {
      const options = new Set(indices.map(i => rows[i].values[field]).filter(Boolean));
      if (options.size === 1) values[field] = [...options][0];
    }
    const times = [...new Set(indices.map(i => rows[i].values[3]).filter(t => /\d{2}:\d{2}:\d{2}$/.test(t)))];
    if (times.length === 1 && times[0].startsWith(values[4])) values[3] = times[0];
    const conflicts = [0, 4, 5, 6, 7, 10, ...(!values[10] ? [9] : [])].flatMap(field => {
      const options = [...new Set(indices.map(i => rows[i].values[field]).filter(Boolean))];
      return options.length > 1 ? [{ field, values: options, observations: indices }] : [];
    });
    return { id: `E${index + 1}`, representative: chosen, observations: indices, values, conflicts };
  });
  return { events, links };
}

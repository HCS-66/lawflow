import type { AssembledRow } from './sourceAssembly';
import type { ObservationContext } from './observationConsolidation';

/** A substantial partial overlap is a reviewable duplication risk even when automatic merging fails. */
export function findUnmergedViewOverlaps(rows: AssembledRow[], context: ObservationContext[], eventForObservation: Map<number, number>) {
  const groups = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const key = `${row.values[0]}|${context[i].directOwner ? 'row' : 'header'}|${context[i].accountKind}`;
    groups.set(key, [...(groups.get(key) || []), i]);
  });
  const entries = [...groups.entries()], overlaps: Array<{ observations: number[]; anchors: number }> = [];
  const key = (i: number) => [4, 5, 6, 7].every(f => rows[i].values[f]) ? JSON.stringify([4, 5, 6, 7].map(f => rows[i].values[f])) : '';
  for (let a = 0; a < entries.length; a++) for (let b = a + 1; b < entries.length; b++) {
    const left = entries[a][1], right = entries[b][1];
    if (context[left[0]].accountKind !== context[right[0]].accountKind || context[left[0]].directOwner === context[right[0]].directOwner) continue;
    const matching = left.flatMap(i => {
      const value = key(i); if (!value) return [];
      const candidates = right.filter(j => key(j) === value);
      return candidates.length === 1 && left.filter(j => key(j) === value).length === 1 ? [{ left: i, right: candidates[0] }] : [];
    });
    if (matching.length < 3 || new Set(matching.map(p => rows[p.left].values[4])).size < 2) continue;
    if (matching.every(p => eventForObservation.get(p.left + 1) === eventForObservation.get(p.right + 1))) continue;
    overlaps.push({ observations: [...left, ...right].map(i => i + 1), anchors: matching.length });
  }
  return overlaps;
}

import type { SourceCell, SourceSelection } from './sourceAssembly';

/** Split only a complete, unambiguous printed account/name pair. Never invent digits. */
export function selectSourceParty(cell: SourceCell, part: 'account' | 'name'): SourceSelection[] | null {
  if (!['account', 'name'].includes(part)) throw new Error('Invalid party fragment selector');
  if (!cell.text.trim() || /^(?:--?|—|无)$/.test(cell.text.trim())) return [];
  if (/^[\d*＊xX]{8,32}$/.test(cell.text.replace(/\s/g, ''))) {
    return part === 'account' ? [cell.id] : [];
  }
  const pieces = cell.text.split(/[\/／|｜]|\r?\n|\\n/).map(s => s.trim());
  if (pieces.length !== 2) return null;
  const account = (s: string) => /^[\d*＊xX]{8,32}$/.test(s.replace(/\s/g, ''));
  const name = (s: string) => Boolean(s) && !account(s) && !/^[\d\s*＊]+$/.test(s);
  const index = account(pieces[0]) && (name(pieces[1]) || !pieces[1]) ? 0
    : account(pieces[1]) && (name(pieces[0]) || !pieces[0]) ? 1 : -1;
  if (index < 0) return null;
  const text = pieces[part === 'account' ? index : 1 - index];
  return text ? [{ id: cell.id, text }] : [];
}

/** Model selectors may point at one printed line; returned text must remain an exact substring. */
export function selectSourceLine(cell: SourceCell, line?: number): SourceSelection[] {
  if (line === undefined) return [cell.id];
  if (!Number.isInteger(line) || line < 0) throw new Error('Invalid source line selector');
  const pieces = cell.text.split(/\r?\n|\\n/);
  if (line >= pieces.length || !pieces[line].trim()) return [];
  const text = pieces[line].trim();
  return [{ id: cell.id, text, line }];
}

/** Remove OCR spacing around an otherwise explicit decimal/sign, not between separate quantities. */
export function normalizePrintedNumberSpacing(text: string): string {
  return text.trim().replace(/^([+-])[ \t]+(?=\d)/, '$1')
    .replace(/(?<=\d)[ \t]*,[ \t]*(?=\d)/g, ',')
    .replace(/(?<=\d)[ \t]*\.[ \t]*(?=\d{1,2}$)/, '.');
}

import type { SourceCell, SourceSelection } from './sourceAssembly';

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

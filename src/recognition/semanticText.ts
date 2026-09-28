/** Layout wrapping is not part of a Chinese transaction description's meaning. */
export function semanticText(text: string): string {
  return text.replace(/\\n|\s/g, '');
}

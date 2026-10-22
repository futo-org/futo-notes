/** Locale-independent matching, with every Greek sigma folded to the same letter. */
export function foldCase(text: string): string {
  return text.toLowerCase().replace(/ς/g, 'σ');
}

/** Find needs folded offsets to remain offsets into the original document. */
export function foldCaseWithOffsets(text: string): string {
  const folded = foldCase(text);
  if (folded.length === text.length) return folded;
  let result = '';
  for (const character of text) {
    const lower = foldCase(character);
    result += lower.length === character.length ? lower : character;
  }
  return result;
}

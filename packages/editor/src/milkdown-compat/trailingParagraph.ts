import type { Node as ProseNode } from '@milkdown/kit/prose/model';

/**
 * Does `doc` end in blank space its serialization does not hold — so a text
 * equal to that serialization is still not the same document? Either more
 * trailing empty paragraphs than a parse leaves, or an empty last line.
 */
export function endsInUnwrittenBlank(doc: ProseNode): boolean {
  return hasSurplusTrailingEmptyParagraphs(doc) || endsWithUnwrittenLine(doc);
}

/**
 * Does `doc` end in more empty paragraphs than a fresh parse of its own
 * serialization would leave?
 *
 * The serializer does not write the document's trailing empty paragraphs
 * (docs/spec/editor.md "Markdown house style"): `@milkdown/plugin-trailing`
 * parks one after a document whose last block is not a paragraph or heading,
 * so the caret has somewhere to go below it, and Enter at the end stacks more.
 * A load parks exactly one empty paragraph after a document whose last block is
 * not a paragraph or heading — or, for a document with no such block at all,
 * keeps the single one `block+` requires — and none after a document ending in
 * a paragraph or heading. So "same bytes" does not mean "same document": a host
 * `setContent` whose text equals the serialization must still be applied when
 * this is true, or the previous note's blank paragraphs stay on screen under
 * the next note's text (RC-22 regression, F-2).
 */
export function hasSurplusTrailingEmptyParagraphs(doc: ProseNode): boolean {
  const children: ProseNode[] = [];
  doc.forEach((child) => children.push(child));
  let end = children.length;
  while (end > 0 && isEmptyParagraph(children[end - 1] as ProseNode)) end -= 1;
  const trailing = children.length - end;
  const last = children[end - 1];
  // Mirrors @milkdown/plugin-trailing's default `shouldAppend`.
  const parked =
    last === undefined || (last.type.name !== 'paragraph' && last.type.name !== 'heading');
  return trailing > (parked ? 1 : 0);
}

/**
 * Whether the note's last written block is a paragraph ending in a line break
 * — an empty last line (Enter at the end of the note, src/features/editor/
 * milkdown/paragraphLines.ts) the file cannot hold: trailing whitespace is not
 * content, so the document serializes exactly like one without it. Trailing
 * empty paragraphs are skipped: those are not written either.
 */
export function endsWithUnwrittenLine(doc: ProseNode): boolean {
  for (let index = doc.childCount - 1; index >= 0; index -= 1) {
    const block = doc.child(index);
    if (block.type.name !== 'paragraph') return false;
    if (block.content.size > 0) return block.lastChild?.type.name === 'hardbreak';
  }
  return false;
}

function isEmptyParagraph(node: ProseNode): boolean {
  return node.type.name === 'paragraph' && node.content.size === 0;
}

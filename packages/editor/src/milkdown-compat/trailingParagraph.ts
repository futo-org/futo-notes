import type { Node as ProseNode } from '@milkdown/kit/prose/model';

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

function isEmptyParagraph(node: ProseNode): boolean {
  return node.type.name === 'paragraph' && node.content.size === 0;
}

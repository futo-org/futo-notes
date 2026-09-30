/*
 * Pasted HTML blocks, flattened to the one line a table cell can hold (RC-83).
 *
 * A GFM cell is inline-only. ProseMirror's HTML parser, given several `<p>` (or
 * `<li>`, `<h1>`...) with the caret in a cell, wraps each block in a NEW CELL,
 * and prosemirror-tables' `handlePaste` then pastes that run of cells over the
 * caret's cell and the ones after it: `| c1 | c2 |` + `<p>a</p><p>b</p>` saved
 * `| a | b |`. The plain-text twin is RC-81 (`plainTextBlockPaste.ts`).
 *
 * Replacing every block element by its own children plus one space, before
 * ProseMirror parses the HTML, leaves a single inline run: the words stay
 * joined by a space and inline marks (`<b>`, `<a href>`) are untouched, so they
 * survive as marks. Anything that mentions a table element is left alone: a
 * pasted `<table>`, row or cell is a spreadsheet paste and overwrites cell by
 * cell on purpose.
 */

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'UL',
]);

const TABLE_TAGS = /<\s*(?:table|thead|tbody|tfoot|tr|td|th|caption|colgroup)\b/i;

function isBlock(node: Node): boolean {
  return node.nodeType === 1 && BLOCK_TAGS.has((node as Element).tagName);
}

function containsBlock(root: ParentNode): boolean {
  return root.querySelector([...BLOCK_TAGS].map((tag) => tag.toLowerCase()).join(',')) !== null;
}

/** Unwraps every block under `parent`, deepest first, leaving a space where each ended. */
function unwrapBlocks(parent: Node): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    unwrapBlocks(element);
    if (element.tagName === 'BR') {
      element.replaceWith(parent.ownerDocument!.createTextNode(' '));
    } else if (isBlock(element)) {
      element.replaceWith(
        ...Array.from(element.childNodes),
        parent.ownerDocument!.createTextNode(' '),
      );
    }
  }
}

/** The HTML with its blocks flattened into inline content, or null to leave it as it is. */
export function flattenHtmlBlocks(html: string): string | null {
  if (TABLE_TAGS.test(html)) return null;
  const template = document.createElement('template');
  template.innerHTML = html;
  if (!containsBlock(template.content)) return null;
  unwrapBlocks(template.content);
  return template.innerHTML.replace(/^\s+|\s+$/g, '');
}

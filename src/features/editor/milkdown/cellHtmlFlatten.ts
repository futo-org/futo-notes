/*
 * Pasted HTML blocks, flattened to the one line a table cell can hold (RC-83).
 *
 * A GFM cell is inline-only. ProseMirror's HTML parser, given several `<p>` (or
 * `<li>`, `<h1>`...) with the caret in a cell, wraps each block in a NEW CELL,
 * and prosemirror-tables' `handlePaste` then pastes that run of cells over the
 * caret's cell and the ones after it: `| c1 | c2 |` + `<p>a</p><p>b</p>` saved
 * `| a | b |`. The plain-text twin is RC-81 (`plainTextBlockPaste.ts`).
 *
 * Re-emitting the HTML with every block element replaced by its own children
 * and a space on BOTH sides, before ProseMirror parses it, leaves a single inline run: the words
 * stay apart (a space only after a block fused `<span>a</span><p>b</p>` into
 * `ab`) and inline marks (`<b>`, `<a href>`) are untouched, so they survive as
 * marks. Runs of whitespace collapse to one space and the ends are trimmed. A
 * paste that holds a table element (found in the parsed DOM, so a custom
 * `<table-of-contents>` does not count) is left alone: a pasted `<table>`, row
 * or cell is a spreadsheet paste and overwrites cell by cell on purpose.
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

const TABLE_ELEMENTS = 'table,thead,tbody,tfoot,tr,td,th,caption,colgroup,col';
/** Content that is not text but is not nothing: a paste of only these is not blank. */
const MEDIA_ELEMENTS = 'img,svg,picture,video,audio,iframe,object,embed,canvas,input';

function isBlock(element: Element): boolean {
  return BLOCK_TAGS.has(element.tagName);
}

function containsBlock(root: ParentNode): boolean {
  return root.querySelector([...BLOCK_TAGS].map((tag) => tag.toLowerCase()).join(',')) !== null;
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Re-emits `root` as an HTML string, blocks and `<br>` dissolved into single
 * spaces. It READS the tree and never moves a node: unwrapping by moving
 * children is quadratic in jsdom (a Range extraction of 10,000 siblings took
 * 15 s), and spreading them into `replaceWith(...)` overflows the call stack at
 * about 125,000 siblings.
 */
function emit(root: Node): string {
  const out: string[] = [];
  let endsWithSpace = true; // nothing yet: a leading space would only be trimmed
  const space = () => {
    if (!endsWithSpace) out.push(' ');
    endsWithSpace = true;
  };
  const walk = (parent: Node) => {
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3) {
        const text = (node.nodeValue ?? '').replace(/[\s\u00a0]+/g, ' ');
        const trimmed = endsWithSpace ? text.replace(/^ /, '') : text;
        if (trimmed === '') continue;
        out.push(escapeText(trimmed));
        endsWithSpace = trimmed.endsWith(' ');
      } else if (node.nodeType === 1) {
        const element = node as Element;
        if (element.tagName === 'BR') {
          space();
        } else if (isBlock(element)) {
          space();
          walk(element);
          space();
        } else {
          const shell = (element.cloneNode(false) as Element).outerHTML;
          const close = `</${element.localName}>`;
          if (shell.endsWith(close)) {
            out.push(shell.slice(0, -close.length));
            walk(element);
            out.push(close);
          } else {
            out.push(shell); // a void element (img, wbr...)
            endsWithSpace = false;
            walk(element);
          }
        }
      }
    }
  };
  walk(root);
  return out.join('').replace(/ $/, '');
}

/**
 * The HTML with its blocks flattened into inline content, `''` when what is left
 * is blank (a whitespace-only paste pastes nothing, as plain text does), or null
 * to leave it as it is.
 */
export function flattenHtmlBlocks(html: string): string | null {
  try {
    const template = document.createElement('template');
    template.innerHTML = html;
    const root = template.content;
    if (root.querySelector(TABLE_ELEMENTS) !== null) return null;
    if (!containsBlock(root)) return null;
    if (root.textContent!.trim() === '' && root.querySelector(MEDIA_ELEMENTS) === null) return '';
    return emit(root);
  } catch {
    // Anything the DOM cannot take (a stack overflow on absurd nesting): paste as it was.
    return null;
  }
}

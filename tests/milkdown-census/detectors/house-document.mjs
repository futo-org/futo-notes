/**
 * The note as the markdown house style reads it: `houseDocument`.
 */

/**
 * The document a note reads as, with everything a fixed house style may change
 * taken out, so two readings compare equal exactly when the save lost or
 * changed nothing the author wrote. Stated here, not imported from the
 * serializer, so the gate does not trust the code it gates. Each rule is a line
 * of docs/spec/editor.md "Markdown house style".
 *
 * Spelling-only attributes — what a parse derives from HOW the file spelled
 * something, not from what it holds — are dropped:
 *   - `emphasis.marker`, `strong.marker`: `*` or `_`, the file's choice.
 *   - `heading.id`: a slug of the heading's text.
 *   - `list_item.label`, `list_item.listType`: `•`/`3.` and bullet/ordered,
 *     derived from the parent list and the item's position.
 *   - `table_header.colwidth`, `table_cell.colwidth`: markdown has no widths.
 *   - `table_cell.alignment` (body cells): the delimiter row sets a column's
 *     alignment, read from the header cell, which keeps it.
 *   - a link's `title` of `""` reads the same as none; an image's missing
 *     title is the schema's `''`.
 *   - `table_row.filler`: the editor marks the row it fills in under a
 *     header-only table; no parse sets it.
 * Normalizations the house style makes on purpose:
 *   - whitespace at the start of a line — a paragraph's, heading's or cell's
 *     first, and in a paragraph each one after a line break — is dropped,
 *     inside formatting too, but not inside a link's text or a code span, nor
 *     on a task item's first line, which follows `[ ] ` in the file (the
 *     parser keeps it there, and drops it everywhere else on every read);
 *   - whitespace before a soft line break, and at the end of a paragraph,
 *     heading or table cell, is dropped, then a line break at the very end of
 *     a paragraph or heading (the parser drops both on every read; a cell's
 *     last `<br>` reads back as a line break, so it stays);
 *   - a table cell holding one line break and nothing else (once its edge
 *     whitespace is gone) is empty: a lone `<br>` in a cell reads back as an
 *     empty cell, while two or more read back as line breaks;
 *   - a heading's line breaks are spaces (an ATX heading is one line);
 *   - a paragraph is split at each empty line inside it — a soft line break
 *     ending a line that holds nothing (whitespace counts as nothing; a line
 *     where a link opens or closes holds its `[` or `](…)`) — since
 *     an empty line in the file ends a paragraph: `n` empty lines between two
 *     lines of text are a paragraph break and `n - 1` empty paragraphs, `n` at
 *     its start are `n` empty paragraphs before it, and the line break before
 *     an empty line ends a paragraph, so it goes like any break at the end;
 *   - empty paragraphs at the start or end of a quote, list item or footnote,
 *     and at the end of the note, are dropped (no spelling reaches them; a list
 *     item's empty first child, the schema's filler, stays unless the item's
 *     first block is a paragraph, and the empty paragraphs after a first
 *     paragraph that holds text are inside the item, not at its start);
 *   - CR and CRLF inside code and HTML are LF (front matter is written byte
 *     for byte, line endings included);
 *   - an HTML block's indentation before its first tag is dropped (layout, not
 *     HTML; only a block's value can start with whitespace);
 *   - in a tight list item, two paragraph children in a row are joined into
 *     one, a soft line break between them (`- a\n  b` is one paragraph; only
 *     the editor makes the pair, with Backspace at a nested item's start).
 *     Not the paragraphs one child is split into at an empty line, and never
 *     a paragraph that is one HTML block;
 *   - a list item whose blocks still need a blank line between them — two
 *     paragraphs in a row that were not joined, or an empty paragraph between
 *     two blocks — is loose: no tight spelling keeps them apart;
 *   - a table body row with no cells (the schema's filler for a header-only
 *     table) and a `filler` row whose cells are all empty (that row once the
 *     editor filled it in) are dropped: a table with no body row is written
 *     with none.
 * Text runs whose marks then agree are merged, and an emptied paragraph is an
 * empty paragraph.
 */
const SPELLING_ATTRS = {
  heading: ['id'],
  list_item: ['label', 'listType'],
  table_header: ['colwidth'],
  table_cell: ['colwidth', 'alignment'],
  table_row: ['filler'],
};
const CONTAINERS = new Set(['blockquote', 'list_item', 'footnote_definition']);
const lf = (value) => value.replace(/\r\n?/g, '\n');

function houseMarkKey(mark) {
  if (mark.type === 'link')
    return `link\u0000${mark.attrs?.href ?? ''}\u0000${mark.attrs?.title || ''}`;
  return mark.type;
}

function houseMarks(marks) {
  return (marks ?? []).map(houseMarkKey).sort().join('\u0001');
}

function isEmptyParagraph(node) {
  return node.type === 'paragraph' && (node.content?.length ?? 0) === 0;
}

const htmlBlock = (node) => node.content?.length === 1 && node.content[0].type === 'html';

/**
 * A tight list item's children, each house-normalized into its blocks
 * (`parts`), with two paragraph CHILDREN in a row joined as lines of one. The
 * paragraphs one child was split into at an empty line stay apart.
 */
function joinParagraphs(parts) {
  const joinable = (node) =>
    node.type === 'paragraph' && !isEmptyParagraph(node) && !htmlBlock(node);
  const out = [];
  for (const [first, ...rest] of parts) {
    if (!first) continue;
    const last = out[out.length - 1];
    if (last && joinable(last) && joinable(first)) {
      const soft = { type: 'hardbreak', attrs: { isInline: true } };
      out[out.length - 1] = { ...last, content: [...last.content, soft, ...first.content] };
    } else out.push(first);
    out.push(...rest);
  }
  return out;
}

/** A list item's blocks (trimmed) that only a blank line keeps apart; its first may be the schema's filler. */
function needsBlankLine(content) {
  return content.some((child, i) => {
    if (i === 0 || child.type !== 'paragraph') return false;
    if (isEmptyParagraph(child)) return true;
    const previous = content[i - 1];
    return previous.type === 'paragraph' && !isEmptyParagraph(previous) && !htmlBlock(child);
  });
}

function houseInline(content, kind, afterCheckbox = false) {
  let nodes = content.map((node) => {
    if (node.type === 'html') return node;
    if (kind === 'heading' && node.type === 'hardbreak')
      return { type: 'text', text: ' ', marks: node.marks };
    return node;
  });
  const merge = (list) => {
    const out = [];
    for (const node of list) {
      if (node.type === 'text' && !node.text) continue;
      const last = out[out.length - 1];
      if (
        last?.type === 'text' &&
        node.type === 'text' &&
        houseMarks(last.marks) === houseMarks(node.marks)
      ) {
        out[out.length - 1] = { ...last, text: last.text + node.text };
      } else out.push(node);
    }
    return out;
  };
  // Code is delimited, so its edge spaces survive a read: never trimmed.
  const trimmable = (node) =>
    node.type === 'text' && !(node.marks ?? []).some((mark) => mark.type === 'inlineCode');
  const stripBefore = (list, end) => {
    for (let i = end - 1; i >= 0 && trimmable(list[i]); i -= 1) {
      const text = list[i].text.replace(/[ \t]+$/, '');
      list[i] = { ...list[i], text };
      if (text !== '') return;
    }
  };
  // A link's text and a code span keep their edge spaces on a read; nothing else at a line's start does.
  const stripAfter = (list, start) => {
    for (let i = start; i < list.length && trimmable(list[i]); i += 1) {
      if ((list[i].marks ?? []).some((mark) => mark.type === 'link')) return;
      const text = list[i].text.replace(/^[ \t]+/, '');
      list[i] = { ...list[i], text };
      if (text !== '') return;
    }
  };
  nodes = merge(nodes);
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].type === 'hardbreak' && nodes[i].attrs?.isInline === true) stripBefore(nodes, i);
  }
  if (!afterCheckbox) stripAfter(nodes, 0);
  for (let i = 0; i < nodes.length; i += 1) {
    if (kind === 'paragraph' && nodes[i].type === 'hardbreak') stripAfter(nodes, i + 1);
  }
  nodes = merge(nodes);
  for (;;) {
    stripBefore(nodes, nodes.length);
    nodes = merge(nodes);
    if (nodes[nodes.length - 1]?.type !== 'hardbreak' || kind === 'cell') break;
    nodes.pop();
  }
  const lone = nodes.length === 1 && nodes[0].type === 'hardbreak';
  return kind === 'cell' && lone ? [] : nodes;
}

/**
 * A paragraph's house-normalized content split at its empty lines (see
 * `houseDocument`): one content array per paragraph it reads as, `[]` for an
 * empty one.
 */
function splitParagraph(content, afterCheckbox = false) {
  const isSoft = (node) => node.type === 'hardbreak' && node.attrs?.isInline === true;
  const links = (node) =>
    (node?.marks ?? [])
      .filter((mark) => mark.type === 'link')
      .map(houseMarkKey)
      .sort()
      .join('\u0001');
  const linkEdge = (node, previous) => links(node) !== links(previous);
  const out = [];
  let line = [];
  let blanks = 0;
  let lineEmpty = true;
  let split = false;
  let previous;
  const close = () => {
    const first = afterCheckbox && !out.some((block) => block.length > 0) && blanks === 0;
    const text = houseInline(line, 'paragraph', first);
    line = [];
    if (text.length === 0) return;
    const empties = out.some((block) => block.length > 0) ? blanks - 1 : blanks;
    for (let i = 0; i < empties; i += 1) out.push([]);
    out.push(text);
    blanks = 0;
  };
  for (const node of content) {
    const empty = lineEmpty && isSoft(node) && !linkEdge(node, previous);
    previous = node;
    if (empty) {
      close();
      split = true;
      blanks += 1;
      continue;
    }
    line.push(node);
    lineEmpty = node.type === 'hardbreak';
  }
  if (!split) return [content];
  close();
  return out.length > 0 ? out : [[]];
}

/**
 * Whether a table body row is one no file holds: no cells, or the editor's
 * `filler` row with every cell empty. `row` is house-normalized (a cell's lone
 * line break is already gone); the mark is read off `source`, the row as the
 * document held it, since `houseNode` drops it from `row`.
 */
function unwrittenRow(row, source) {
  if (row.type !== 'table_row') return false;
  const cells = row.content ?? [];
  if (cells.length === 0) return true;
  if (source?.attrs?.filler !== true) return false;
  return cells.every((cell) => (cell.content ?? []).every(isEmptyParagraph));
}

/** `node` house-normalized: one node, or several for a paragraph split at its empty lines. */
function houseBlocks(node, inCell = false, afterCheckbox = false) {
  if (node.type !== 'paragraph' || inCell || !node.content) return [houseNode(node, inCell)];
  const content = houseInline(node.content, 'paragraph', afterCheckbox);
  return splitParagraph(content, afterCheckbox).map((paragraph) =>
    houseNode({ ...node, content: paragraph }, false, true),
  );
}

function houseNode(node, inCell = false, inlineDone = false) {
  const out = { type: node.type };
  if (node.attrs) {
    const dropped = SPELLING_ATTRS[node.type] ?? [];
    const attrs = {};
    for (const key of Object.keys(node.attrs).sort()) {
      if (dropped.includes(key)) continue;
      let value = node.attrs[key];
      if (node.type === 'image' && key === 'title') value = value ?? '';
      if (node.type === 'html' && key === 'value') value = lf(value);
      if (node.type === 'html' && key === 'value') value = value.replace(/^[ \t]+/, '');
      attrs[key] = value;
    }
    if (Object.keys(attrs).length > 0) out.attrs = attrs;
  }
  if (node.marks?.length) out.marks = houseMarks(node.marks);
  if (node.text !== undefined) out.text = node.text;
  let content = node.content ?? [];
  if (node.type === 'code_block') {
    const text = lf(content.map((child) => child.text ?? '').join(''));
    content = text ? [{ type: 'text', text }] : [];
  } else if ((node.type === 'paragraph' || node.type === 'heading') && !inlineDone) {
    content = houseInline(content, inCell ? 'cell' : node.type);
  }
  const cell = node.type === 'table_header' || node.type === 'table_cell';
  // A task item's first paragraph follows `[ ] ` on its line, so it keeps its leading whitespace.
  const task = node.type === 'list_item' && typeof node.attrs?.checked === 'boolean';
  const first = task ? content.findIndex((child) => !isEmptyParagraph(child)) : -1;
  const parts = content.map((child, i) =>
    houseBlocks(child, cell, i === first && child.type === 'paragraph'),
  );
  const tightItem = node.type === 'list_item' && node.attrs?.spread !== true;
  content = tightItem ? joinParagraphs(parts) : parts.flat();
  if (CONTAINERS.has(node.type)) {
    const item = node.type === 'list_item';
    // After an item's first paragraph that holds text, blank lines are inside the item.
    const leading = !item || (content.length > 0 && isEmptyParagraph(content[0]));
    let start = 0;
    while (leading && start < content.length && isEmptyParagraph(content[start])) start += 1;
    let end = content.length;
    while (end > start && isEmptyParagraph(content[end - 1])) end -= 1;
    const kept = content.slice(start, end);
    // The filler stays only in front of an item whose first block is not a paragraph.
    const filler = item && start > 0 && kept[0]?.type !== 'paragraph';
    content = filler ? [content[0], ...kept] : kept;
  }
  if (tightItem && out.attrs && needsBlankLine(content)) out.attrs.spread = true;
  // One normalized row per row of the table, so `node.content[i]` is row i's source.
  if (node.type === 'table')
    content = content.filter((row, i) => !unwrittenRow(row, node.content[i]));
  if (node.type === 'doc') {
    while (content.length > 0 && isEmptyParagraph(content[content.length - 1])) content.pop();
  }
  if (content.length > 0) out.content = content;
  return out;
}

/** The note as `houseNode` compares it: a string, so equality is `===`. */
export function houseDocument(docJson) {
  return JSON.stringify(houseNode(docJson));
}

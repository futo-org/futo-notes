/*
 * WHAT the `/` menu offers, and which items a query matches.
 *
 * Metadata only — no ProseMirror, no DOM, no Milkdown — so the offer set and
 * the match rules are unit-testable on their own (`items.test.ts`) and the
 * renderer and the command implementations each read one list instead of
 * restating it. `exec.ts` implements every id here; `index.ts` renders them.
 *
 * The set is the one the CodeMirror editor's block-command menu offered, minus
 * Image: inserting a picture needs a file picker and a vault write, which the
 * desktop shell has no path for yet (docs/plan/desktop-editor-parity.md D2, and
 * the toolbar manifest's `pickImage` action, which only the native hosts
 * answer). Everything else is a block format the editor already implements.
 */

export interface SlashItem {
  /** Stable id. `exec.ts` implements exactly this set. */
  id: string;
  /** The row's title. */
  label: string;
  /** The row's second line — what the block is, in the reader's words. */
  hint: string;
  /**
   * Extra words a query may match. The label is always matched too, so these
   * are only the names a user might reach for instead: `h1`, `todo`, `hr`.
   */
  keywords: string[];
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: 'paragraph', label: 'Text', hint: 'Plain paragraph', keywords: ['paragraph', 'body', 'p'] },
  { id: 'heading-1', label: 'Heading 1', hint: 'Large section heading', keywords: ['h1', 'title'] },
  { id: 'heading-2', label: 'Heading 2', hint: 'Medium section heading', keywords: ['h2'] },
  { id: 'heading-3', label: 'Heading 3', hint: 'Small section heading', keywords: ['h3'] },
  {
    id: 'bullet-list',
    label: 'Bullet list',
    hint: 'Unordered list',
    keywords: ['ul', 'unordered', 'list'],
  },
  {
    id: 'ordered-list',
    label: 'Numbered list',
    hint: 'Ordered list',
    keywords: ['ol', 'ordered', 'number', 'list'],
  },
  {
    id: 'task-list',
    label: 'Task list',
    hint: 'Checkbox list',
    keywords: ['todo', 'checklist', 'checkbox'],
  },
  { id: 'quote', label: 'Quote', hint: 'Block quote', keywords: ['blockquote', 'citation'] },
  {
    id: 'code-block',
    label: 'Code block',
    hint: 'Fenced code',
    keywords: ['pre', 'fence', 'snippet'],
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: 'Horizontal rule',
    keywords: ['hr', 'horizontal', 'rule', 'separator', 'line'],
  },
  { id: 'table', label: 'Table', hint: 'Markdown table', keywords: ['grid', 'cells', 'rows'] },
];

/**
 * Ranked matches for `query` — the text typed after the `/`.
 *
 * Prefix beats substring and label beats keyword, so `/h` leads with the
 * headings rather than whichever item happens to contain an "h", and `/li`
 * leads with the lists. Ties keep manifest order, which is the order a reader
 * scanning the unfiltered menu already learned. An empty query offers
 * everything; a query nothing matches offers nothing, and the caller hides the
 * menu rather than showing an empty box.
 */
export function filterSlashItems(query: string, items: SlashItem[] = SLASH_ITEMS): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;

  const scored: { item: SlashItem; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const label = item.label.toLowerCase();
    const id = item.id.toLowerCase();
    let score = 0;
    if (label.startsWith(q)) score = 100;
    else if (id.startsWith(q)) score = 90;
    else if (label.includes(q)) score = 60;
    else if (item.keywords.some((k) => k.toLowerCase().startsWith(q))) score = 50;
    else if (item.keywords.some((k) => k.toLowerCase().includes(q))) score = 30;
    if (score > 0) scored.push({ item, score, order });
  });

  // Stable by construction rather than by trusting the engine's sort: the
  // recorded index breaks every tie, so the order is the same in every WebView.
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((s) => s.item);
}

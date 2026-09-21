/*
 * WHAT the `/` menu offers, and which items a query matches.
 *
 * Metadata only — no ProseMirror, no DOM, no Milkdown — so the offer set and
 * the match rules are unit-testable on their own (`items.test.ts`) and the
 * renderer and the command implementations each read one list instead of
 * restating it. `exec.ts` implements every id here; `index.ts` renders them.
 *
 * The set is mostly the one the CodeMirror editor's block-command menu
 * offered. Every item but Link and Image is a block format the editor already
 * implements; Image opens the host's file picker and writes into the vault,
 * through the same `PlatformFS` pair (`pickImage` + `saveImage`) the
 * CodeMirror toolbar button used before the engine swap deleted it. Link
 * (QA-019, Orhan's suggestion) is new: it opens the same URL prompt the
 * desktop selection toolbar's Link button does (`../linkPrompt/`).
 *
 * Image is offered on every host the menu itself is offered on — the menu is
 * desktop-only (`resolveSlashMenu`), and desktop is exactly where the picker
 * exists. On a host with no picker at all (a plain browser) the item is inert
 * rather than hidden: `imageInsert.ts` reports `canPick` false and picking it
 * inserts nothing, which is the same "decline, never corrupt" rule image paste
 * already follows.
 */

export interface SlashItem {
  /** Stable id. `exec.ts` implements exactly this set. */
  id: string;
  /**
   * The row's title, in English — matched against the query (`filterSlashItems`
   * runs on this, never on the localized text) and never rendered directly.
   * `menu.ts` renders `localizedText(labelPath)` instead, so matching stays
   * locale-invariant while the row a user sees is in their own language.
   */
  label: string;
  /** The catalog path `menu.ts` resolves for the row's rendered title. */
  labelPath: string;
  /** The row's second line, in English — same matching/render split as `label`. */
  hint: string;
  /** The catalog path `menu.ts` resolves for the row's rendered second line. */
  hintPath: string;
  /**
   * Extra words a query may match. The label is always matched too, so these
   * are only the names a user might reach for instead: `h1`, `todo`, `hr`.
   */
  keywords: string[];
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'paragraph',
    label: 'Text',
    labelPath: 'editor.slashMenu.commands.paragraph',
    hint: 'Plain paragraph',
    hintPath: 'editor.slashMenu.commands.paragraphHint',
    keywords: ['paragraph', 'body', 'p'],
  },
  {
    id: 'heading-1',
    label: 'Heading 1',
    labelPath: 'editor.slashMenu.commands.headingOne',
    hint: 'Large section heading',
    hintPath: 'editor.slashMenu.commands.headingOneHint',
    keywords: ['h1', 'title'],
  },
  {
    id: 'heading-2',
    label: 'Heading 2',
    labelPath: 'editor.slashMenu.commands.headingTwo',
    hint: 'Medium section heading',
    hintPath: 'editor.slashMenu.commands.headingTwoHint',
    keywords: ['h2'],
  },
  {
    id: 'heading-3',
    label: 'Heading 3',
    labelPath: 'editor.slashMenu.commands.headingThree',
    hint: 'Small section heading',
    hintPath: 'editor.slashMenu.commands.headingThreeHint',
    keywords: ['h3'],
  },
  {
    id: 'bullet-list',
    label: 'Bullet list',
    labelPath: 'editor.slashMenu.commands.bulletList',
    hint: 'Unordered list',
    hintPath: 'editor.slashMenu.commands.bulletListHint',
    keywords: ['ul', 'unordered', 'list'],
  },
  {
    id: 'ordered-list',
    label: 'Numbered list',
    labelPath: 'editor.slashMenu.commands.numberedList',
    hint: 'Ordered list',
    hintPath: 'editor.slashMenu.commands.numberedListHint',
    keywords: ['ol', 'ordered', 'number', 'list'],
  },
  {
    id: 'task-list',
    label: 'Task list',
    labelPath: 'editor.slashMenu.commands.taskList',
    hint: 'Checkbox list',
    hintPath: 'editor.slashMenu.commands.taskListHint',
    keywords: ['todo', 'checklist', 'checkbox'],
  },
  {
    id: 'quote',
    label: 'Quote',
    labelPath: 'editor.slashMenu.commands.blockQuote',
    hint: 'Block quote',
    hintPath: 'editor.slashMenu.commands.blockQuoteHint',
    keywords: ['blockquote', 'citation'],
  },
  {
    id: 'code-block',
    label: 'Code block',
    labelPath: 'editor.slashMenu.commands.codeBlock',
    hint: 'Fenced code',
    hintPath: 'editor.slashMenu.commands.codeBlockHint',
    keywords: ['pre', 'fence', 'snippet'],
  },
  {
    id: 'divider',
    label: 'Divider',
    labelPath: 'editor.slashMenu.commands.divider',
    hint: 'Horizontal rule',
    hintPath: 'editor.slashMenu.commands.dividerHint',
    keywords: ['hr', 'horizontal', 'rule', 'separator', 'line'],
  },
  {
    id: 'table',
    label: 'Table',
    labelPath: 'editor.slashMenu.commands.table',
    hint: 'Markdown table',
    hintPath: 'editor.slashMenu.commands.tableHint',
    keywords: ['grid', 'cells', 'rows'],
  },
  {
    id: 'link',
    label: 'Link',
    labelPath: 'editor.slashMenu.commands.link',
    hint: 'Insert a link',
    hintPath: 'editor.slashMenu.commands.linkHint',
    // Not `href`: it starts with "hr" and would collide with Divider's own
    // `hr` keyword (items.test.ts pins `/hr` to Divider alone).
    keywords: ['url', 'hyperlink'],
  },
  {
    id: 'image',
    label: 'Image',
    labelPath: 'editor.slashMenu.commands.image',
    hint: 'Insert a picture from a file',
    hintPath: 'editor.slashMenu.commands.imageHint',
    keywords: ['picture', 'photo', 'img', 'file'],
  },
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

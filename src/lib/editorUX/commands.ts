import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import {
  toggleBulletList,
  toggleOrderedList,
  toggleTaskList,
  toggleBlockquote,
  insertImageFromFile,
} from '$lib/markdownToolbar';

/**
 * Shared command registry.
 *
 * Used by both the slash menu (typed `/foo` in a block) and the block handle's `+` button.
 * Keeping it in one place means the two surfaces stay in sync and tests only need to cover
 * one source of truth.
 *
 * Each command's `run(view, at)` receives the cursor position `at` — for the slash menu
 * this is the position AFTER the typed `/query` was deleted, so the command can safely
 * mutate the line it lives on. For the block handle's + button it's the position of the
 * newly-inserted empty paragraph.
 */
export interface EditorCommand {
  id: string;
  label: string;
  /** Short hint shown in the menu (max ~40 chars) */
  hint?: string;
  /** Keywords for fuzzy/substring matching; the label itself is always matched too */
  keywords?: string[];
  /** Icon name — we resolve these in the menu renderer. Keep to lucide icon names. */
  icon: string;
  run(view: EditorView, at: number): void;
}

/**
 * Set the current line's prefix, replacing any existing managed prefix.
 * Used for headings and plain paragraph resets — different from `toggleLinePrefix`
 * because we *force* a specific prefix rather than toggling.
 */
function setLinePrefix(view: EditorView, at: number, prefix: string): void {
  const line = view.state.doc.lineAt(at);
  // Strip any existing heading/list/quote prefix
  const stripped = line.text.replace(/^(\s*)(#{1,6}\s+|[-*+]\s+\[([ xX])\]\s+|[-*+]\s+|\d+\.\s+|>\s+)/, '$1');
  const leading = (stripped.match(/^\s*/) || [''])[0];
  const body = stripped.slice(leading.length);
  const newText = `${leading}${prefix}${body}`;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: newText },
    selection: EditorSelection.cursor(line.from + leading.length + prefix.length),
  });
  view.focus();
}

function setHeading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  return (view: EditorView, at: number) => {
    setLinePrefix(view, at, '#'.repeat(level) + ' ');
  };
}

function setParagraph(view: EditorView, at: number): void {
  setLinePrefix(view, at, '');
}

function insertCodeBlock(view: EditorView, at: number): void {
  const line = view.state.doc.lineAt(at);
  const leading = (line.text.match(/^\s*/) || [''])[0];
  const content = line.text.slice(leading.length);
  // Replace the current line with ```\n<content>\n```
  const block = `${leading}\`\`\`\n${content}\n${leading}\`\`\``;
  const contentLineStart = line.from + `${leading}\`\`\`\n`.length;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: block },
    selection: EditorSelection.cursor(contentLineStart + content.length),
  });
  view.focus();
}

function insertDivider(view: EditorView, at: number): void {
  const line = view.state.doc.lineAt(at);
  // Replace the current line with `---\n\n` and land the cursor on the trailing
  // empty line. The HR widget is reveal-sensitive — it suppresses itself when the
  // cursor is on the `---` line — so we HAVE to land the cursor below, not on it.
  const insert = `---\n\n`;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: EditorSelection.cursor(line.from + insert.length),
  });
  view.focus();
}

function insertTable(view: EditorView, at: number): void {
  const line = view.state.doc.lineAt(at);
  const table = `| Column 1 | Column 2 |\n| --- | --- |\n|  |  |`;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: table },
    // Put cursor in the first header cell
    selection: EditorSelection.cursor(line.from + '| '.length),
  });
  view.focus();
}

export const EDITOR_COMMANDS: EditorCommand[] = [
  {
    id: 'paragraph',
    label: 'Paragraph',
    hint: 'Plain text',
    keywords: ['text', 'body', 'p'],
    icon: 'Pilcrow',
    run: setParagraph,
  },
  {
    id: 'heading-1',
    label: 'Heading 1',
    hint: 'Large section heading',
    keywords: ['h1', 'title'],
    icon: 'Heading1',
    run: setHeading(1),
  },
  {
    id: 'heading-2',
    label: 'Heading 2',
    hint: 'Medium section heading',
    keywords: ['h2'],
    icon: 'Heading2',
    run: setHeading(2),
  },
  {
    id: 'heading-3',
    label: 'Heading 3',
    hint: 'Small section heading',
    keywords: ['h3'],
    icon: 'Heading3',
    run: setHeading(3),
  },
  {
    id: 'bullet-list',
    label: 'Bullet list',
    hint: 'Unordered list',
    keywords: ['ul', 'unordered', 'list'],
    icon: 'List',
    run: (view) => toggleBulletList(view),
  },
  {
    id: 'ordered-list',
    label: 'Numbered list',
    hint: 'Ordered list',
    keywords: ['ol', 'ordered', 'number', 'list'],
    icon: 'ListOrdered',
    run: (view) => toggleOrderedList(view),
  },
  {
    id: 'task-list',
    label: 'Task list',
    hint: 'Checkbox list',
    keywords: ['todo', 'checklist', 'checkbox'],
    icon: 'ListChecks',
    run: (view) => toggleTaskList(view),
  },
  {
    id: 'quote',
    label: 'Blockquote',
    hint: 'Quote block',
    keywords: ['quote', 'blockquote'],
    icon: 'TextQuote',
    run: (view) => toggleBlockquote(view),
  },
  {
    id: 'code-block',
    label: 'Code block',
    hint: 'Fenced code',
    keywords: ['code', 'pre', 'fence'],
    icon: 'Code',
    run: insertCodeBlock,
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: 'Horizontal rule',
    keywords: ['hr', 'horizontal', 'rule', 'separator'],
    icon: 'Minus',
    run: insertDivider,
  },
  {
    id: 'table',
    label: 'Table',
    hint: 'Markdown table',
    keywords: ['grid', 'cells'],
    icon: 'Table',
    run: insertTable,
  },
  {
    id: 'image',
    label: 'Image',
    hint: 'Insert image from file',
    keywords: ['img', 'picture', 'photo'],
    icon: 'Image',
    run: (view) => {
      // Defer past the slash-menu's delete transaction so the file picker opens
      // against a settled doc/focus state. Without this, the picker's modal
      // dismissal would race the delete and sometimes leave focus on nothing.
      queueMicrotask(() => {
        insertImageFromFile(view)
          .then(() => view.focus())
          .catch((err) => {
            console.error('[editorUX/image] insertImageFromFile failed:', err);
            view.focus();
          });
      });
    },
  },
];

/**
 * Substring + prefix scoring filter. Prefix matches on label rank highest, then
 * substring matches on label, then keyword matches. Case-insensitive.
 */
export function filterCommands(query: string, commands: EditorCommand[] = EDITOR_COMMANDS): EditorCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;

  const scored: Array<{ cmd: EditorCommand; score: number }> = [];
  for (const cmd of commands) {
    const label = cmd.label.toLowerCase();
    const idLc = cmd.id.toLowerCase();
    let score = 0;
    if (label.startsWith(q)) score = 100;
    else if (idLc.startsWith(q)) score = 90;
    else if (label.includes(q)) score = 60;
    else if (cmd.keywords?.some((k) => k.toLowerCase().startsWith(q))) score = 50;
    else if (cmd.keywords?.some((k) => k.toLowerCase().includes(q))) score = 30;
    if (score > 0) scored.push({ cmd, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.cmd);
}

/**
 * Toolbar command parity, Milkdown engine — executable.
 *
 * Every `exec` id in the shared manifest (packages/editor/src/toolbar.ts), run
 * through `FutoEditor.exec` exactly as the two native toolbars and the embed
 * fallback run it, asserted on the markdown that comes back out. This is the
 * ONE place the manifest's editing behavior is pinned for this engine — no
 * shell restates it (M10), and `everyExecIdIsImplemented` fails if a new
 * manifest item arrives without a case here.
 *
 * The block-format model is the spec's, not ProseMirror's defaults: one block
 * prefix per line, a kind tapped onto itself removes it, a different kind
 * converts (docs/spec/editor.md → "Markdown toolbar"). Milkdown's preset
 * commands are bare `wrapIn`s, so all of that lives in
 * `src/features/editor/milkdown/blockCommands.ts`.
 *
 * Engine-independent bridge contract, the load-echo guard and the undo boundary
 * are in `editor-embed-milkdown.spec.ts`; the block drag is in
 * `editor-embed-milkdown-long-press.spec.ts` and the gutter-handle files.
 */

import { expect } from '@playwright/test';
import { TOOLBAR_EXEC_IDS } from '@futo-notes/editor';
import {
  clearMessages,
  focusEditor,
  getContent,
  messagesOfType,
  waitForMessages,
} from './lib/editorEmbedHost';
import {
  test,
  settle,
  hostSetContent,
  exec,
  caretIn,
  selectAll,
  afterExec,
} from './lib/editorEmbedMilkdownToolbar';

// ============================================================
// The manifest is covered
// ============================================================

/**
 * Every id asserted below. Deliberately a literal list rather than something
 * derived from the manifest: the point of the check underneath is to fail when
 * the manifest grows an item this file has no case for.
 */
const COVERED_EXEC_IDS = [
  'undo',
  'redo',
  'bold',
  'italic',
  'strikethrough',
  'link',
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
  'quote',
  'code-block',
  'bullet-list',
  'ordered-list',
  'task-list',
  'indent',
  'outdent',
];

test('every manifest exec id has a parity case here', () => {
  expect([...COVERED_EXEC_IDS].sort()).toEqual([...TOOLBAR_EXEC_IDS].sort());
});

test('exec warns about an unknown command and leaves the note alone', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  await hostSetContent(page, 'x');
  await exec(page, 'not-a-command');

  expect(await getContent(page)).toBe('x');
  // The editor's own `exec` is what warns now: `createFutoEditorApi`'s
  // TOOLBAR_EXEC fallback went with the CodeMirror engine (ea65cf5a), so every
  // command runs through the editor and the message moved with it.
  expect(warnings.join('\n')).toContain("MilkdownEditor.exec: unsupported command 'not-a-command'");
});

// ============================================================
// Inline marks
// ============================================================

test('bold, italic and strikethrough wrap the selection', async ({ page }) => {
  await hostSetContent(page, 'hello');
  await focusEditor(page);
  await selectAll(page);
  await exec(page, 'bold');
  expect((await getContent(page)).trimEnd()).toBe('**hello**');

  await selectAll(page);
  await exec(page, 'italic');
  expect((await getContent(page)).trimEnd()).toBe('***hello***');

  await selectAll(page);
  await exec(page, 'strikethrough');
  // Marks over the same text nest strikethrough outermost (the house style).
  expect((await getContent(page)).trimEnd()).toBe('~~***hello***~~');
});

test('bold on an already-bold selection removes it', async ({ page }) => {
  await hostSetContent(page, '**hello**');
  await focusEditor(page);
  await selectAll(page);
  await exec(page, 'bold');
  expect((await getContent(page)).trimEnd()).toBe('hello');
});

test('an inline mark with no selection applies to the text typed next', async ({ page }) => {
  await hostSetContent(page, 'x');
  await focusEditor(page);
  await exec(page, 'bold');
  await page.keyboard.type('yz');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('x**yz**');
});

// ============================================================
// Undo / Redo (QA-003) — first toolbar items, prosemirror-history's own stack
// ============================================================

test('undo reverts the last change and redo replays it', async ({ page }) => {
  await hostSetContent(page, 'hello');
  await focusEditor(page);
  await selectAll(page);
  await exec(page, 'bold');
  expect((await getContent(page)).trimEnd()).toBe('**hello**');

  await exec(page, 'undo');
  expect((await getContent(page)).trimEnd()).toBe('hello');

  await exec(page, 'redo');
  expect((await getContent(page)).trimEnd()).toBe('**hello**');
});

test('undo/redo report disabled in formatState when their stacks are empty', async ({ page }) => {
  await hostSetContent(page, 'hello');
  await focusEditor(page);
  await selectAll(page);
  await clearMessages(page);

  await exec(page, 'bold');
  let disabled = (await waitForMessages(page, 'formatState')).at(-1)?.disabled as string[];
  expect(disabled).toContain('redo');
  expect(disabled).not.toContain('undo');

  await clearMessages(page);
  await exec(page, 'undo');
  disabled = (await waitForMessages(page, 'formatState')).at(-1)?.disabled as string[];
  expect(disabled).toContain('undo');
  expect(disabled).not.toContain('redo');
});

// ============================================================
// Code block (QA-009) — was missing from the manifest entirely, on every
// mobile shell, not only Android.
// ============================================================

test('code-block converts a plain paragraph into a fenced code block', async ({ page }) => {
  expect(await afterExec(page, 'hello', 'code-block')).toBe('```\nhello\n```');
});

// ============================================================
// Indent / outdent
// ============================================================

test('indent nests a list item under its preceding sibling', async ({ page }) => {
  expect(await afterExec(page, '- one\n- two', 'indent')).toBe('- one\n  - two');
});

test('outdent lifts a nested item back one level', async ({ page }) => {
  await hostSetContent(page, '- one\n  - two');
  await focusEditor(page);
  await caretIn(page, 'two');
  await exec(page, 'outdent');
  expect((await getContent(page)).trimEnd()).toBe('- one\n- two');
});

test('outdent on a top-level item leaves the list', async ({ page }) => {
  expect(await afterExec(page, '- one', 'outdent')).toBe('one');
});

// A list item can only nest under a PRECEDING SIBLING item, so the first item
// of a list has nothing to nest under and Indent leaves the note untouched —
// including its bytes, because a no-op never trips the load-echo guard.
test('indent on the first item of a list is a no-op', async ({ page }) => {
  expect(await afterExec(page, '- one', 'indent')).toBe('- one');
});

// ============================================================
// formatState — the active-format highlight every toolbar renders
// ============================================================

test('formatState reports the kind a block command just applied', async ({ page }) => {
  await hostSetContent(page, 'hello');
  await focusEditor(page);

  for (const [id, active] of [
    ['bullet-list', ['bullet-list']],
    ['ordered-list', ['ordered-list']],
    ['task-list', ['task-list']],
    ['quote', ['quote']],
    ['heading-1', ['heading-1', 'quote']],
  ] as Array<[string, string[]]>) {
    await clearMessages(page);
    await exec(page, id);
    expect((await waitForMessages(page, 'formatState')).at(-1)?.active).toEqual(active);
  }
});

test('formatState clears when the same command removes the kind', async ({ page }) => {
  await hostSetContent(page, '- hello');
  await focusEditor(page);
  await clearMessages(page);
  await exec(page, 'bullet-list');
  expect((await waitForMessages(page, 'formatState')).at(-1)?.active).toEqual([]);
});

test('a task item reports task-list and never also bullet-list', async ({ page }) => {
  await hostSetContent(page, '- [ ] hello');
  await focusEditor(page);
  await clearMessages(page);
  await exec(page, 'bold');
  const active = (await waitForMessages(page, 'formatState')).at(-1)?.active as string[];
  expect(active).toContain('task-list');
  expect(active).not.toContain('bullet-list');
});

test('formatState is posted right after a toolbar tap, not only on selection moves', async ({
  page,
}) => {
  await hostSetContent(page, 'hello');
  await focusEditor(page);
  await clearMessages(page);
  await exec(page, 'quote');
  expect((await messagesOfType(page, 'formatState')).length).toBeGreaterThan(0);
});

// ============================================================
// cursorContext — Indent/Outdent visibility on the native toolbars
// ============================================================

// The native toolbars gate Indent/Outdent on this message, so a tap that turns
// a paragraph INTO a list has to report the new caret context immediately —
// `selectionUpdated` alone reports the state the caret was in before the tap.
test('cursorContext follows a toolbar tap that creates or removes a list', async ({ page }) => {
  await hostSetContent(page, 'hello');
  await focusEditor(page);
  await clearMessages(page);

  await exec(page, 'bullet-list');
  expect((await waitForMessages(page, 'cursorContext')).at(-1)?.onListLine).toBe(true);

  await clearMessages(page);
  await exec(page, 'bullet-list');
  expect((await waitForMessages(page, 'cursorContext')).at(-1)?.onListLine).toBe(false);
});

// `inContainer` (list item OR blockquote) is what the native toolbars key
// Indent/Outdent visibility on now; `onListLine` (list only) stays as it was,
// for hosts that never learn the newer field.
test('cursorContext reports inContainer for a quote too, unlike onListLine', async ({ page }) => {
  await hostSetContent(page, 'hello');
  await focusEditor(page);
  await clearMessages(page);

  await exec(page, 'quote');
  const quoted = (await waitForMessages(page, 'cursorContext')).at(-1);
  expect(quoted?.onListLine).toBe(false);
  expect(quoted?.inContainer).toBe(true);

  // `quote` is a one-way, explicit choice — `paragraph` leaves an enclosing
  // quote in place (blockCommands.ts `setBlockFormat`); `outdent` is what
  // lifts a single-level quote back out.
  await clearMessages(page);
  await exec(page, 'outdent');
  const unquoted = (await waitForMessages(page, 'cursorContext')).at(-1);
  expect(unquoted?.onListLine).toBe(false);
  expect(unquoted?.inContainer).toBe(false);

  await clearMessages(page);
  await exec(page, 'bullet-list');
  const bulleted = (await waitForMessages(page, 'cursorContext')).at(-1);
  expect(bulleted?.onListLine).toBe(true);
  expect(bulleted?.inContainer).toBe(true);
});

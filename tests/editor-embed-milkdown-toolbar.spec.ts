import { expect, test as base, type Page } from '@playwright/test';

import { TOOLBAR_EXEC_IDS } from '@futo-notes/editor';
import { EDITOR_URL } from './editorEmbedBundle';
import {
  clearMessages,
  flushFrames,
  focusEditor,
  getContent,
  installFakeAndroidHost,
  messagesOfType,
  waitForMessages,
  type FakeHostWindow,
} from './lib/editorEmbedHost';

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
 * Engine-independent bridge contract, the load-echo guard, the undo boundary
 * and the block drag are in `editor-embed-milkdown.spec.ts`.
 */

/** @milkdown/plugin-listener debounces `markdownUpdated` by 200 ms (trailing). */
const CHANGE_DEBOUNCE_MS = 200;

const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({ hasTouch: true });
    await context.addInitScript(installFakeAndroidHost);
    const page = await context.newPage();
    await page.goto(EDITOR_URL);
    await page.waitForFunction(() =>
      (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
    );
    await use(page);
    await context.close();
  },
});

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 80);
  await flushFrames(page);
}

async function hostSetContent(page: Page, markdown: string): Promise<void> {
  await page.evaluate(
    (md) => (window as unknown as FakeHostWindow).FutoEditor.setContent(md),
    markdown,
  );
  await settle(page);
}

async function exec(page: Page, ...ids: string[]): Promise<void> {
  for (const id of ids) {
    await page.evaluate(
      (commandId) =>
        (
          window as unknown as FakeHostWindow & { FutoEditor: { exec(id: string): void } }
        ).FutoEditor.exec(commandId),
      id,
    );
    await settle(page);
  }
}

/** Put the caret in the block whose rendered text is `text`. */
async function caretIn(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).first().click();
  await flushFrames(page);
}

/**
 * Select the whole document with a real Ctrl/Cmd-A. Triple-click is not usable
 * here: over a rendered `<a>` it resolves to the word, not the block.
 */
async function selectAll(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+a');
  await flushFrames(page);
}

/**
 * Load `markdown`, run `ids`, and return the markdown the editor produces.
 * Loading leaves the caret at the end of the document, which is the block
 * every single-block case here is about.
 */
async function afterExec(page: Page, markdown: string, ...ids: string[]): Promise<string> {
  await hostSetContent(page, markdown);
  await focusEditor(page);
  await exec(page, ...ids);
  return (await getContent(page)).trimEnd();
}

// ============================================================
// The manifest is covered
// ============================================================

/**
 * Every id asserted below. Deliberately a literal list rather than something
 * derived from the manifest: the point of the check underneath is to fail when
 * the manifest grows an item this file has no case for.
 */
const COVERED_EXEC_IDS = [
  'bold',
  'italic',
  'strikethrough',
  'link',
  'heading',
  'quote',
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
  expect(warnings.join('\n')).toContain("unknown command id 'not-a-command'");
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
  expect((await getContent(page)).trimEnd()).toBe('***~~hello~~***');
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
// Link
// ============================================================

test('link wraps the selection and tapping it again unwraps', async ({ page }) => {
  await hostSetContent(page, 'hello world');
  await focusEditor(page);
  await selectAll(page);
  await exec(page, 'link');
  expect((await getContent(page)).trimEnd()).toBe('[hello world]()');

  await selectAll(page);
  await exec(page, 'link');
  expect((await getContent(page)).trimEnd()).toBe('hello world');
});

test('link keeps an existing href when it unwraps and re-wraps', async ({ page }) => {
  await hostSetContent(page, '[docs](https://example.com)');
  await focusEditor(page);
  await selectAll(page);
  await exec(page, 'link');
  expect((await getContent(page)).trimEnd()).toBe('docs');
});

// The WYSIWYG equivalent of CodeMirror's `[]()` scaffold: there is no source
// text to put a caret into, so the mark is armed for what the user types next.
test('link with no selection links the text typed next', async ({ page }) => {
  await hostSetContent(page, 'x');
  await focusEditor(page);
  await exec(page, 'link');
  await page.keyboard.type('abc');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('x[abc]()');
});

// ============================================================
// Block formats — applying a kind to a plain paragraph
// ============================================================

const APPLIED: Array<[string, string]> = [
  ['bullet-list', '- hello'],
  ['ordered-list', '1. hello'],
  ['task-list', '- [ ] hello'],
  ['quote', '> hello'],
  ['heading', '# hello'],
];

for (const [id, expected] of APPLIED) {
  test(`${id} on a plain paragraph produces ${JSON.stringify(expected)}`, async ({ page }) => {
    expect(await afterExec(page, 'hello', id)).toBe(expected);
  });
}

// ============================================================
// Block formats — tapping the same kind removes it
// ============================================================

const REMOVED: Array<[string, string]> = [
  ['bullet-list', '- hello'],
  ['ordered-list', '1. hello'],
  ['task-list', '- [ ] hello'],
  ['quote', '> hello'],
];

for (const [id, source] of REMOVED) {
  test(`${id} on ${JSON.stringify(source)} removes it`, async ({ page }) => {
    expect(await afterExec(page, source, id)).toBe('hello');
  });
}

// A conversion between two kinds is two ProseMirror primitives underneath
// (lift out of the blockquote, then wrap in a list). One tap has to be one undo.
test('a conversion between two kinds is a single undo step', async ({ page }) => {
  expect(await afterExec(page, '> hello', 'bullet-list')).toBe('- hello');

  await page.keyboard.press('ControlOrMeta+z');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('> hello');
});

// The bug this replaced: the preset's wrapInBlockquoteCommand NESTED, so a
// second tap produced `> > hello` instead of unwrapping.
test('quote never nests a second blockquote', async ({ page }) => {
  expect(await afterExec(page, 'hello', 'quote', 'quote', 'quote')).toBe('> hello');
});

test('heading cycles h1 -> h2 -> h3 -> plain', async ({ page }) => {
  expect(await afterExec(page, 'hello', 'heading')).toBe('# hello');
  expect(await afterExec(page, 'hello', 'heading', 'heading')).toBe('## hello');
  expect(await afterExec(page, 'hello', 'heading', 'heading', 'heading')).toBe('### hello');
  expect(await afterExec(page, 'hello', 'heading', 'heading', 'heading', 'heading')).toBe('hello');
});

// ============================================================
// Block formats — converting between kinds
// ============================================================

const CONVERSIONS: Array<[string, string, string]> = [
  ['- hello', 'ordered-list', '1. hello'],
  ['1. hello', 'bullet-list', '- hello'],
  ['- hello', 'task-list', '- [ ] hello'],
  ['- [ ] hello', 'bullet-list', '- hello'],
  ['1. hello', 'task-list', '- [ ] hello'],
  ['- hello', 'quote', '> hello'],
  ['> hello', 'bullet-list', '- hello'],
  ['- hello', 'heading', '# hello'],
  ['# hello', 'bullet-list', '- hello'],
  ['> hello', 'heading', '# hello'],
  ['## hello', 'quote', '> hello'],
];

for (const [source, id, expected] of CONVERSIONS) {
  test(`${id} turns ${JSON.stringify(source)} into ${JSON.stringify(expected)}`, async ({
    page,
  }) => {
    expect(await afterExec(page, source, id)).toBe(expected);
  });
}

// editor.md: "Converting a checked task drops its checkbox state along with
// the task prefix."
test('converting a checked task drops the checkbox', async ({ page }) => {
  expect(await afterExec(page, '- [x] hello', 'bullet-list')).toBe('- hello');
});

test('bullet markers serialize as - , matching the CodeMirror engine', async ({ page }) => {
  expect(await afterExec(page, 'a\n\nb', 'bullet-list')).toBe('a\n\n- b');
});

// ============================================================
// Block formats — nesting survives a conversion
// ============================================================

test('converting a list converts the enclosing list and keeps the nested one', async ({ page }) => {
  await hostSetContent(page, '- a\n- b\n  - c');
  await focusEditor(page);
  await caretIn(page, 'a');
  await exec(page, 'ordered-list');
  expect((await getContent(page)).trimEnd()).toBe('1. a\n2. b\n   - c');
});

test('making a nested item a task leaves it nested', async ({ page }) => {
  await hostSetContent(page, '- a\n  - b');
  await focusEditor(page);
  await caretIn(page, 'b');
  await exec(page, 'task-list');
  expect((await getContent(page)).trimEnd()).toBe('- a\n  - [ ] b');
});

// ============================================================
// A selection spanning several blocks
// ============================================================

/** Drag-select from the block reading `first` to the block reading `last`. */
async function dragSelect(page: Page, first: string, last: string): Promise<void> {
  const a = await page.getByText(first, { exact: true }).first().boundingBox();
  const b = await page.getByText(last, { exact: true }).first().boundingBox();
  if (!a || !b) throw new Error(`no geometry for ${first}..${last}`);
  await page.mouse.move(a.x + 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await flushFrames(page);
}

async function afterExecAcross(
  page: Page,
  markdown: string,
  first: string,
  last: string,
  id: string,
): Promise<string> {
  await hostSetContent(page, markdown);
  await focusEditor(page);
  await dragSelect(page, first, last);
  await exec(page, id);
  return (await getContent(page)).trimEnd();
}

test('several selected paragraphs become ONE list, not one list each', async ({ page }) => {
  expect(await afterExecAcross(page, 'a\n\nb', 'a', 'b', 'bullet-list')).toBe('- a\n- b');
});

// Plain ProseMirror `lift` cannot lift two list items into the document, so
// this was a silent no-op: selecting a whole list and tapping Bullet did nothing.
test('tapping Bullet across a whole list removes every marker', async ({ page }) => {
  expect(await afterExecAcross(page, '- a\n- b', 'a', 'b', 'bullet-list')).toBe('a\n\nb');
});

test('tapping Ordered across a whole list converts every item', async ({ page }) => {
  expect(await afterExecAcross(page, '- a\n- b', 'a', 'b', 'ordered-list')).toBe('1. a\n2. b');
});

// editor.md: "A multi-line selection applies that transition separately to
// each line" — the h1 advances to h2 while the paragraph becomes h1.
test('a mixed selection gets the transition applied per line', async ({ page }) => {
  expect(await afterExecAcross(page, '# a\n\nb', 'a', 'b', 'heading')).toBe('## a\n\n# b');
});

// A wikilink is an ATOM node inside the paragraph (#101). A block command has
// to move the paragraph around it without disturbing or unwrapping it — the
// one place this ticket's document surgery and the wikilink work overlap.
test('a block command carries a wikilink through untouched', async ({ page }) => {
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setNotes(
      JSON.stringify([{ id: 'target', title: 'target', modifiedMs: 0 }]),
    ),
  );
  expect(await afterExec(page, 'see [[target]] here', 'bullet-list')).toBe('- see [[target]] here');
  expect(await afterExec(page, '- see [[target]] here', 'quote')).toBe('> see [[target]] here');
  expect(await afterExec(page, '> see [[target]] here', 'heading')).toBe('# see [[target]] here');
});

// The task checkbox is a widget decoration keyed off the item's `checked`
// attribute (#102), and the Task command is what sets that attribute. The two
// have to agree: making a task must render a checkbox, unmaking one must remove
// it.
test('the Task command renders and removes the checkbox widget', async ({ page }) => {
  const checkboxes = page.locator('.ProseMirror input[type="checkbox"]');

  await hostSetContent(page, 'hello');
  await focusEditor(page);
  await expect(checkboxes).toHaveCount(0);

  await exec(page, 'task-list');
  expect((await getContent(page)).trimEnd()).toBe('- [ ] hello');
  await expect(checkboxes).toHaveCount(1);

  await exec(page, 'task-list');
  expect((await getContent(page)).trimEnd()).toBe('hello');
  await expect(checkboxes).toHaveCount(0);
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
    ['heading', ['heading']],
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
// The embed fallback toolbar — the same commands, tapped for real
// ============================================================

/**
 * The web toolbar the embed renders on hosts that do NOT set
 * `nativeToolbar` (`EmbedToolbar.svelte`). Everything above drives `exec()`
 * the way the native shells do; this drives the buttons themselves, so the
 * fallback's own dispatch and active-state rendering are covered rather than
 * assumed.
 */
async function showEmbedToolbar(page: Page, markdown: string): Promise<void> {
  await page.evaluate(
    (json) => (window as unknown as FakeHostWindow).FutoEditor.initialize(json),
    JSON.stringify({
      bridgeVersion: 7,
      theme: 'light',
      content: markdown,
      nativeToolbar: false,
      contentPaddingInlinePx: 14,
    }),
  );
  await focusEditor(page);
  await expect(page.locator('.markdown-toolbar')).toBeVisible();
}

function toolbarButton(page: Page, label: string) {
  return page.locator('.markdown-toolbar').getByRole('button', { name: label, exact: true });
}

test('tapping the embed toolbar runs the same command exec does', async ({ page }) => {
  await showEmbedToolbar(page, 'hello');
  await toolbarButton(page, 'Bullet list').click();
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('- hello');

  await toolbarButton(page, 'Bullet list').click();
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('hello');
});

test('the embed toolbar highlights the command active at the caret', async ({ page }) => {
  await showEmbedToolbar(page, 'hello');
  const quoteButton = toolbarButton(page, 'Block quote');
  await expect(quoteButton).not.toHaveClass(/is-active/);

  await quoteButton.click();
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('> hello');
  await expect(quoteButton).toHaveClass(/is-active/);

  await quoteButton.click();
  await settle(page);
  await expect(quoteButton).not.toHaveClass(/is-active/);
});

test('the embed toolbar shows Indent/Outdent only on a list line', async ({ page }) => {
  await showEmbedToolbar(page, 'hello');
  await expect(toolbarButton(page, 'Indent')).toHaveCount(0);

  await toolbarButton(page, 'Bullet list').click();
  await settle(page);
  await expect(toolbarButton(page, 'Indent')).toBeVisible();
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

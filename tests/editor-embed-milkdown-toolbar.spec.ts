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
// Link (QA-005) — opens the shared URL prompt, same as the desktop
// selection toolbar and the `/` menu's Link item (linkPrompt/).
// ============================================================

function linkUrlField(page: Page) {
  return page.locator('input[aria-label="Link URL"]');
}

test('link with a selection opens a URL field; Enter applies it over the selection', async ({
  page,
}) => {
  await hostSetContent(page, 'hello world');
  await focusEditor(page);
  await selectAll(page);
  await exec(page, 'link');

  const url = linkUrlField(page);
  await expect(url).toBeVisible();
  await expect(url).toBeFocused();
  await url.fill('https://example.test');
  await url.press('Enter');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('[hello world](https://example.test)');
});

test('link on an existing link prefills its href; emptying it removes the link', async ({
  page,
}) => {
  await hostSetContent(page, '[docs](https://example.com)');
  await focusEditor(page);
  // A selection strictly INSIDE the link's run, not `selectAll` — the whole
  // document here IS the link, and a selection all the way out to the doc's
  // own boundary resolves outside any textblock, which is not what a real
  // text selection landing on a link ever does. A double-click (word select)
  // is one atomic browser action, unlike click-then-Home/Shift+End, which
  // races the click's asynchronous selectionchange (AGENTS.md M15 — wait on a
  // condition, not a sleep, and this sidesteps the wait entirely).
  await page.getByText('docs', { exact: true }).first().dblclick();
  await flushFrames(page);
  await exec(page, 'link');

  const url = linkUrlField(page);
  await expect(url).toHaveValue('https://example.com');
  await url.fill('');
  await url.press('Enter');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('docs');
});

// The WYSIWYG equivalent of CodeMirror's `[]()` scaffold: there is no source
// text to put a caret into, so submitting inserts the URL as its own label
// and leaves it selected, ready to be typed straight over.
test('link with no selection inserts the URL as its own selected label', async ({ page }) => {
  await hostSetContent(page, 'x');
  await focusEditor(page);
  await exec(page, 'link');

  const url = linkUrlField(page);
  await expect(url).toBeVisible();
  await url.fill('https://example.test');
  await url.press('Enter');
  await settle(page);
  // The serializer's own autolink shorthand for a link whose label is
  // identical to its href — the same bytes as `[https://example.test](https://example.test)`.
  expect((await getContent(page)).trimEnd()).toBe('x<https://example.test>');

  // Still selected — typing replaces the label rather than appending after it.
  await page.keyboard.type('abc');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('x[abc](https://example.test)');
});

test('Escape in the link field leaves the note untouched', async ({ page }) => {
  await hostSetContent(page, 'hello world');
  await focusEditor(page);
  await selectAll(page);
  await exec(page, 'link');

  const url = linkUrlField(page);
  await url.fill('https://example.test');
  await url.press('Escape');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('hello world');
});

// A bare CARET (no selection) sitting right at the edge of an existing link —
// reachable on a real phone via a selection-handle drag that resolves back to
// a collapsed caret (measured on Android: the Link button is lit from
// `formatState` at exactly this position). `linkRunAt` must be checked before
// the empty-selection branch, or this inserts a second, unrelated link glued
// to the first instead of editing the one under the caret.
test('a caret at the edge of an existing link (no selection) edits that link', async ({ page }) => {
  await hostSetContent(page, '[docs](https://example.com) tail');
  await focusEditor(page);
  await page.evaluate(() => {
    const view = (
      window as unknown as {
        __futoProseMirrorView: () => {
          state: {
            doc: unknown;
            selection: { constructor: { near(pos: unknown): unknown } };
            tr: { setSelection(s: unknown): unknown };
          };
          dispatch: (tr: unknown) => void;
        };
      }
    ).__futoProseMirrorView();
    // Position 5: right after "docs", still inside the link's run.
    const pos = (view.state.doc as { resolve(p: number): unknown }).resolve(5);
    const selection = view.state.selection.constructor.near(pos);
    view.dispatch(
      (view.state.tr.setSelection(selection) as { scrollIntoView(): unknown }).scrollIntoView(),
    );
  });
  await exec(page, 'link');

  const url = linkUrlField(page);
  await expect(url).toHaveValue('https://example.com');
  await url.fill('https://example.test/moved');
  await url.press('Enter');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('[docs](https://example.test/moved) tail');
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
// Block formats — applying a kind to a plain paragraph
// ============================================================

const APPLIED: Array<[string, string]> = [
  ['bullet-list', '- hello'],
  ['ordered-list', '1. hello'],
  ['task-list', '- [ ] hello'],
  ['quote', '> hello'],
  ['heading-1', '# hello'],
  ['heading-2', '## hello'],
  ['heading-3', '### hello'],
  ['paragraph', 'hello'],
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

test('heading levels and Text are explicit and repeatable', async ({ page }) => {
  expect(await afterExec(page, 'hello', 'heading-1', 'heading-1')).toBe('# hello');
  expect(await afterExec(page, '# hello', 'heading-2', 'heading-2')).toBe('## hello');
  expect(await afterExec(page, '## hello', 'heading-3', 'heading-3')).toBe('### hello');
  expect(await afterExec(page, '### hello', 'paragraph')).toBe('hello');
});

test('indent and outdent control quote nesting one level at a time', async ({ page }) => {
  expect(await afterExec(page, 'hello', 'quote', 'indent')).toBe('> > hello');
  await exec(page, 'outdent');
  expect((await getContent(page)).trimEnd()).toBe('> hello');
  await exec(page, 'outdent');
  expect((await getContent(page)).trimEnd()).toBe('hello');
});

test('heading choice gives mixed selected blocks the same level', async ({ page }) => {
  await hostSetContent(page, '# first\n\n## second');
  await focusEditor(page);
  await selectAll(page);
  await exec(page, 'heading-3');
  expect((await getContent(page)).trimEnd()).toBe('### first\n\n### second');
  await page.keyboard.press('ControlOrMeta+z');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('# first\n\n## second');
});

/**
 * The user-facing bug behind dropping `syncHeadingIdPlugin`
 * (packages/editor/src/milkdown-compat): new note, Heading, type — and the
 * characters came out BACKWARDS on iOS (`12345` landed as `# 54321`).
 *
 * The upstream plugin re-stamped the heading's slug `id` attribute in a second
 * transaction after every keystroke, so the block the caret was in had its
 * markup changed and ProseMirror re-created its DOM element mid-typing.
 * WKWebView then inserted the next character at the start of the block. The
 * REVERSAL is WebKit-only, so what this asserts in Chromium is the mechanism:
 * the element the caret is in survives a keystroke, and the id does not churn.
 * Both engines assert the typed order, which is the claim that matters.
 */
test('typing in a heading keeps its order and never re-creates the block', async ({ page }) => {
  await hostSetContent(page, 'hello');
  await focusEditor(page);
  await exec(page, 'heading-1');

  // A live handle on the heading element, so a re-created node is visible as a
  // detached one rather than needing an identity comparison across evaluates.
  await page.evaluate(() => {
    const h1 = document.querySelector('.ProseMirror h1');
    (window as unknown as { __h1: Element | null }).__h1 = h1;
  });

  await page.keyboard.press('End');
  await page.keyboard.type('12345', { delay: 40 });
  await settle(page);

  expect((await getContent(page)).trimEnd()).toBe('# hello12345');

  const heading = await page.evaluate(() => {
    const tracked = (window as unknown as { __h1: Element | null }).__h1;
    const live = document.querySelector('.ProseMirror h1');
    return {
      sameElement: tracked === live,
      stillAttached: tracked?.isConnected ?? false,
      idChurned: (tracked as HTMLElement | null)?.id !== (live as HTMLElement | null)?.id,
    };
  });
  expect(heading.stillAttached).toBe(true);
  expect(heading.sameElement).toBe(true);
  expect(heading.idChurned).toBe(false);
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
  ['- hello', 'heading-1', '# hello'],
  ['# hello', 'bullet-list', '- hello'],
  ['> hello', 'heading-1', '> # hello'],
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

test('bullet markers serialize consistently as -', async ({ page }) => {
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

test('a heading choice applies the same level across mixed blocks', async ({ page }) => {
  expect(await afterExecAcross(page, '# a\n\nb', 'a', 'b', 'heading-1')).toBe('# a\n\n# b');
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
  expect(await afterExec(page, '> see [[target]] here', 'heading-1')).toBe(
    '> # see [[target]] here',
  );
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
// Block formats — a fenced code block is literal text
// ============================================================

/*
 * A block command tapped inside a code block leaves the note's BYTES alone.
 *
 * The reported bug: with the caret on the blank second line of an open fence,
 * Quote wrapped the WHOLE fence in `>` markers (`> \`\`\`` / `> code line one`),
 * the toolbar then reported Quote active, and the text typed next became a
 * third CODE line. A fence's content is literal text, so no markdown block
 * prefix can apply to it (docs/spec/editor.md → "Markdown toolbar").
 */

const FENCE = '```\ncode line one\n```';

/** Put the caret inside the rendered code block. */
async function caretInFence(page: Page): Promise<void> {
  await page.locator('.ProseMirror pre').first().click();
  await flushFrames(page);
}

const BLOCK_IDS = ['heading-1', 'quote', 'bullet-list', 'ordered-list', 'task-list'];

for (const id of [...BLOCK_IDS, 'indent', 'outdent']) {
  test(`${id} inside a fenced code block leaves the note untouched`, async ({ page }) => {
    await hostSetContent(page, FENCE);
    await focusEditor(page);
    await caretInFence(page);
    const before = await getContent(page);
    expect(before).toContain('```');

    await exec(page, id);
    expect(await getContent(page)).toBe(before);
  });
}

// Indent/Outdent are the preset's list commands, so a fence INDENTED UNDER a
// list item is the case where they could still restructure the list while the
// caret sits on a code line.
for (const id of [...BLOCK_IDS, 'indent', 'outdent']) {
  test(`${id} inside a fence nested in a list item leaves the note untouched`, async ({ page }) => {
    await hostSetContent(page, '- one\n- two\n\n  ```\n  nested code\n  ```');
    await focusEditor(page);
    await caretInFence(page);
    const before = await getContent(page);
    expect(before).toContain('nested code');

    await exec(page, id);
    expect(await getContent(page)).toBe(before);
  });
}

// The toolbar highlight has to agree with what the button DID: nothing. The
// reported bug lit Quote up, because the tap really had wrapped the fence.
// `formatState` is deduped, so an unchanged empty set posts nothing at all —
// what this asserts is that no post after the tap names any block command.
test('a tap inside a fence never lights a block button up', async ({ page }) => {
  await hostSetContent(page, FENCE);
  await focusEditor(page);
  await caretInFence(page);
  await clearMessages(page);

  await exec(page, 'quote');
  const posted = await messagesOfType(page, 'formatState');
  expect(posted.flatMap((message) => (message.active as string[] | undefined) ?? [])).toEqual([]);
});

test('quote across a fence formats the prose around it and skips the fence', async ({ page }) => {
  await hostSetContent(page, 'before\n\n```\ncode\n```\n\nafter');
  await focusEditor(page);
  await selectAll(page);
  await exec(page, 'quote');
  expect((await getContent(page)).trimEnd()).toBe('> before\n\n```\ncode\n```\n\n> after');
});

// A GFM table cell holds one line of inline content, so no block prefix can
// apply there either.
for (const id of BLOCK_IDS) {
  test(`${id} inside a table cell leaves the note untouched`, async ({ page }) => {
    await hostSetContent(page, '| head |\n| ---- |\n| body |');
    await focusEditor(page);
    await caretIn(page, 'body');
    const before = await getContent(page);
    expect(before).toContain('body');

    await exec(page, id);
    expect(await getContent(page)).toBe(before);
  });
}

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
  await expect(quoteButton).toHaveClass(/is-active/);
  expect((await getContent(page)).trimEnd()).toBe('> hello');

  await toolbarButton(page, 'Outdent').click();
  await settle(page);
  await expect(quoteButton).not.toHaveClass(/is-active/);
});

test('the embed toolbar greys out Undo/Redo when their stacks are empty, and blocks the tap', async ({
  page,
}) => {
  await showEmbedToolbar(page, 'hello');
  const undoButton = toolbarButton(page, 'Undo');
  const redoButton = toolbarButton(page, 'Redo');
  await expect(undoButton).toHaveClass(/is-disabled/);
  await expect(redoButton).toHaveClass(/is-disabled/);
  await expect(undoButton).toBeDisabled();
  await expect(redoButton).toBeDisabled();

  await selectAll(page);
  await toolbarButton(page, 'Bold').click();
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('**hello**');
  await expect(undoButton).not.toHaveClass(/is-disabled/);
  await expect(redoButton).toHaveClass(/is-disabled/);

  await undoButton.click();
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('hello');
  await expect(undoButton).toHaveClass(/is-disabled/);
  await expect(redoButton).not.toHaveClass(/is-disabled/);
});

test('the embed toolbar shows Indent/Outdent inside a list or quote', async ({ page }) => {
  await showEmbedToolbar(page, 'hello');
  await expect(toolbarButton(page, 'Indent')).toHaveCount(0);

  await toolbarButton(page, 'Bullet list').click();
  await settle(page);
  await expect(toolbarButton(page, 'Indent')).toBeVisible();

  await toolbarButton(page, 'Block quote').click();
  await settle(page);
  await expect(toolbarButton(page, 'Indent')).toBeVisible();
  await toolbarButton(page, 'Outdent').click();
  await settle(page);
  await expect(toolbarButton(page, 'Indent')).toHaveCount(0);
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

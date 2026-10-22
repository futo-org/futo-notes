// Part of the Milkdown toolbar suite: the parity model is described in
// editor-embed-milkdown-toolbar.spec.ts.

import { expect } from '@playwright/test';
import { focusEditor, getContent } from './lib/editorEmbedHost';
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

// docs/spec/editor.md: an empty list item shows its marker straight away. iOS
// WebKit paints no marker for a line that is only ProseMirror's trailing <br>,
// so the editor gives that line a zero-width ::before. Chromium paints the
// marker without it, so a screenshot here proves nothing; this pins that the
// rule applies to exactly that line, and that nothing reaches the file.
for (const [id, marker] of [
  ['bullet-list', '-'],
  ['ordered-list', '1.'],
] as const) {
  test(`${id} on an empty line gives the empty item a zero-width marker anchor`, async ({
    page,
  }) => {
    const anchor = () =>
      page.evaluate(() => {
        const line = document.querySelector('.ProseMirror li > p');
        return line ? getComputedStyle(line, '::before').content : null;
      });

    expect(await afterExec(page, '', id)).toBe(marker);
    expect(await anchor()).toBe('"​"');

    await page.keyboard.type('x');
    await settle(page);
    expect(await anchor()).toBe('none');
    const saved = await getContent(page);
    expect(saved.trimEnd()).toBe(`${marker} x`);
    expect(saved).not.toContain('​');
  });
}

// An EMPTY task item is a task item: the checkbox marker must reach the file
// (the note autosaves in this window), or leaving and reopening turns the fresh
// item into a plain bullet. It used to serialize as a bare `-`, bytes identical
// to an empty Bullet, because the mdast task-list handler writes `[ ]` in front
// of the item's first paragraph and an empty item has none.
test('task-list on an empty line saves the checkbox marker, and it reopens as a task', async ({
  page,
}) => {
  const checkboxes = page.locator('.ProseMirror input[type="checkbox"]');
  expect(await afterExec(page, '', 'task-list')).toBe('- [ ]');
  await expect(checkboxes).toHaveCount(1);

  // The saved bytes reopen as an empty task item, not a bullet with literal text.
  await hostSetContent(page, '- [ ]');
  await expect(checkboxes).toHaveCount(1);

  await page.keyboard.type('x');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('- [ ] x');

  // A checked empty task item, and one that carries a nested list, keep their
  // state and their children across a load and a save.
  for (const source of ['- [x]', '- [ ]\n  - child', 'a\n\n- [x]\n- [ ] b']) {
    await hostSetContent(page, source);
    await focusEditor(page);
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('!');
    await page.keyboard.press('Backspace');
    await settle(page);
    expect((await getContent(page)).trimEnd()).toBe(source);
  }
});

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

// A list or quote at the end of a note gets an empty paragraph parked after it
// (`@milkdown/plugin-trailing`) that a save never writes. Select-all covers it,
// so a block command used to format it too: Bullet twice on `one` left `one\n\n-`.
// Each step re-selects with a real Ctrl/Cmd-A, the way a user would.
const SELECT_ALL_ROUND_TRIPS: Array<[string, string[], string[]]> = [
  ['one', ['bullet-list', 'bullet-list'], ['- one', 'one']],
  ['one\n\ntwo', ['bullet-list', 'bullet-list'], ['- one\n- two', 'one\n\ntwo']],
  ['a\n\nb\n\nc', ['ordered-list', 'ordered-list'], ['1. a\n2. b\n3. c', 'a\n\nb\n\nc']],
  ['one', ['ordered-list', 'ordered-list'], ['1. one', 'one']],
  ['one', ['task-list', 'task-list'], ['- [ ] one', 'one']],
  ['- a\n- b', ['bullet-list'], ['a\n\nb']],
  ['one', ['quote', 'heading-1'], ['> one', '> # one']],
  ['> one', ['code-block'], ['> ```\n> one\n> ```']],
  ['- one', ['code-block'], ['- one']],
];

for (const [source, ids, steps] of SELECT_ALL_ROUND_TRIPS) {
  test(`select-all then ${ids.join(', ')} on ${JSON.stringify(source)} never formats the unsaved trailing line`, async ({
    page,
  }) => {
    await hostSetContent(page, source);
    await focusEditor(page);
    const seen: string[] = [];
    for (const id of ids) {
      await selectAll(page);
      await exec(page, id);
      seen.push((await getContent(page)).trimEnd());
    }
    expect(seen).toEqual(steps);
  });
}

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

// A nested list is a list of its own: Ordered or Bullet tapped on its item
// changes that list alone, and removing the bullet lifts the item clear of
// every list rather than leaving it half-nested.
for (const [id, expected] of [
  ['ordered-list', '- a\n- b\n  1. c'],
  ['bullet-list', '- a\n- b\n\nc'],
] as const) {
  test(`${id} on a nested item changes only that item's list`, async ({ page }) => {
    await hostSetContent(page, '- a\n- b\n  - c');
    await focusEditor(page);
    await caretIn(page, 'c');
    await exec(page, id);
    expect((await getContent(page)).trimEnd()).toBe(expected);
  });
}

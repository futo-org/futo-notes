// Part of the Milkdown toolbar suite: the parity model is described in
// editor-embed-milkdown-toolbar.spec.ts.

import { expect, type Page } from '@playwright/test';
import {
  clearMessages,
  flushFrames,
  focusEditor,
  getContent,
  messagesOfType,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import {
  test,
  hostSetContent,
  exec,
  caretIn,
  selectAll,
  afterExec,
} from './lib/editorEmbedMilkdownToolbar';

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

test('several selected paragraphs become ONE blockquote', async ({ page }) => {
  expect(await afterExecAcross(page, 'a\n\nb', 'a', 'b', 'quote')).toBe('> a\n>\n> b');
});

test('Bullet across a list item and a paragraph toggles each separately', async ({ page }) => {
  expect(await afterExecAcross(page, '- a\n\nb', 'a', 'b', 'bullet-list')).toBe('a\n\n- b');
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

// Indent/Outdent are the preset's list commands, so a fence INDENTED UNDER a
// list item is the case where they could still restructure the list while the
// caret sits on a code line. A GFM table cell holds one line of inline
// content, so no block prefix can apply there either.
const UNTOUCHED: Array<[string, string, (page: Page) => Promise<void>, string[]]> = [
  ['a fenced code block', FENCE, caretInFence, [...BLOCK_IDS, 'indent', 'outdent']],
  [
    'a fence nested in a list item',
    '- one\n- two\n\n  ```\n  nested code\n  ```',
    caretInFence,
    [...BLOCK_IDS, 'indent', 'outdent'],
  ],
  ['a table cell', '| head |\n| ---- |\n| body |', (page) => caretIn(page, 'body'), BLOCK_IDS],
];

for (const [where, markdown, placeCaret, ids] of UNTOUCHED) {
  for (const id of ids) {
    test(`${id} inside ${where} leaves the note untouched`, async ({ page }) => {
      await hostSetContent(page, markdown);
      await focusEditor(page);
      await placeCaret(page);
      const before = await getContent(page);

      await exec(page, id);
      expect(await getContent(page)).toBe(before);
    });
  }
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

for (const [id, expected] of [
  ['quote', '> before\n\n```\ncode\n```\n\n> after'],
  ['bullet-list', '- before\n\n```\ncode\n```\n\n- after'],
] as const) {
  test(`${id} across a fence formats the prose around it and skips the fence`, async ({ page }) => {
    await hostSetContent(page, 'before\n\n```\ncode\n```\n\nafter');
    await focusEditor(page);
    await selectAll(page);
    await exec(page, id);
    expect((await getContent(page)).trimEnd()).toBe(expected);
  });
}

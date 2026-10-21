/**
 * Wikilinks in the Milkdown editor (#101), driven through the SAME single-file
 * `editor.html` the native shells ship and the same `window.FutoEditor` surface
 * they call. One seam proves all three shells: they mount one bundle.
 *
 * Why this suite exists rather than more unit tests: everything below is a
 * behavior the user has, not a function's return value — what the note on disk
 * says after an edit, what the reader sees, what the host is told when a link
 * is tapped, and what a real keyboard does to the `[[` popup. The grammar and
 * the resolution rules are locked one layer down
 * (`src/features/editor/milkdown/wikilink/*.test.ts` and the conformance
 * goldens); this asks whether the feature works.
 *
 * Real input only: Playwright keyboard and touch, never a DOM `dispatchEvent`
 * (AGENTS.md M21).
 */

import { expect } from '@playwright/test';
import {
  clearMessages,
  flushFrames,
  focusEditor,
  getContent,
  messagesOfType,
  waitForMessages,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import {
  test,
  settleChangeDebounce,
  goToEnd,
  open,
  chip,
} from './lib/editorEmbedMilkdownWikilinks';

// ============================================================
// Rendering: shortest unique suffix, broken links
// ============================================================

test('renders a resolved wikilink as its shortest unique path suffix', async ({ page }) => {
  await open(page, 'See [[work/notes/ideas]] today.\n');
  await expect(chip(page)).toHaveText('ideas');
  // The FULL target survives in the document — display and source differ.
  await expect(chip(page)).toHaveAttribute('data-wikilink', 'work/notes/ideas');
});

test('keeps enough of the path to stay unambiguous', async ({ page }) => {
  // Two notes end in "Roadmap", so the folder has to stay on screen.
  await open(page, '[[Projects/Roadmap]]\n');
  await expect(chip(page)).toHaveText('Projects/Roadmap');
});

test('styles an absent target broken and shows its raw text', async ({ page }) => {
  await open(page, '[[no such note]]\n');
  await expect(chip(page)).toHaveText('no such note');
  await expect(chip(page)).toHaveClass(/cm-md-wikilink-broken/);
});

test('styles an AMBIGUOUS target broken, exactly like an absent one', async ({ page }) => {
  await open(page, '[[Roadmap]]\n');
  await expect(chip(page)).toHaveClass(/cm-md-wikilink-broken/);
});

test('a broken wikilink is PAINTED differently from a resolved one', async ({ page }) => {
  // The class alone proved nothing: the distinct-paint rules used to sit in an
  // `@layer components` sheet that the editor's unlayered `a` rule beat, so both
  // chips computed identically (RC-58).
  await open(page, '[[Projects/Roadmap]] [[no such note]]\n');
  const paint = (selector: string) =>
    page.locator(selector).evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.color, decorationStyle: style.textDecorationStyle };
    });
  const resolved = await paint('.ProseMirror a[data-wikilink="Projects/Roadmap"]');
  const broken = await paint('.ProseMirror a[data-wikilink="no such note"]');
  expect(resolved.decorationStyle).toBe('dashed');
  expect(broken.color).not.toBe(resolved.color);
});

test('a wikilink inside inline code is not a link', async ({ page }) => {
  await open(page, 'literal `[[Projects/Roadmap]]` text\n');
  await expect(chip(page)).toHaveCount(0);
});

test('setNotes re-renders a link without touching the document', async ({ page }) => {
  await open(page, '[[later/added]]\n', null);
  await expect(chip(page)).toHaveClass(/cm-md-wikilink-broken/);
  await clearMessages(page);

  await page.evaluate(
    (json) => (window as unknown as FakeHostWindow).FutoEditor.setNotes(json),
    JSON.stringify([{ id: 'later/added', title: 'added', modifiedMs: 0 }]),
  );
  await flushFrames(page);

  await expect(chip(page)).toHaveText('added');
  await expect(chip(page)).not.toHaveClass(/cm-md-wikilink-broken/);
  // CRITICAL: a host call must never look like a user edit — that would
  // normalize-save a note nobody touched.
  await settleChangeDebounce(page);
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
  expect(await getContent(page)).toBe('[[later/added]]\n');
});

/**
 * Rename integrity, editor side. The rewrite itself is the Rust store's job
 * (`relink_note_references`, conformance-locked against `rewriteWikilinks`);
 * what the editor owes is to adopt the rewritten bytes into an OPEN note
 * without treating the adoption as an edit — otherwise renaming a note the
 * user happens to have open bounces a normalize-save straight back at sync.
 */
test('a rename arriving as an external update relinks the open note silently', async ({ page }) => {
  await open(page, 'Link to [[work/notes/ideas]].\n');
  await expect(chip(page)).toHaveText('ideas');
  await clearMessages(page);

  // The host's half of a rename: new universe, then the rewritten body.
  await page.evaluate(
    (json) => {
      const editor = (window as unknown as FakeHostWindow).FutoEditor;
      editor.setNotes(json);
      editor.applyExternalContent(
        'test-note',
        'Link to [[work/notes/plans]].\n',
        (window as unknown as FakeHostWindow).__futoTest.documentRef().generation,
      );
    },
    JSON.stringify([{ id: 'work/notes/plans', title: 'plans', modifiedMs: 0 }]),
  );
  await flushFrames(page);

  await expect(chip(page)).toHaveText('plans');
  await expect(chip(page)).not.toHaveClass(/cm-md-wikilink-broken/);
  await expect(chip(page)).toHaveAttribute('data-wikilink', 'work/notes/plans');
  // Tapping follows the NEW target, so the link is live and not just repainted.
  await chip(page).tap();
  const [openNote] = await waitForMessages(page, 'openNote');
  expect(openNote.id).toBe('work/notes/plans');
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

test('a self-referencing wikilink relinks with the rest', async ({ page }) => {
  // A note linking to itself must not be left broken by its own rename
  // (docs/spec/editor.md, "Renaming or moving a note rewrites every wikilink").
  await open(page, 'Me: [[grocery list]]\n');
  await clearMessages(page);
  await page.evaluate(
    (json) => {
      const editor = (window as unknown as FakeHostWindow).FutoEditor;
      editor.setNotes(json);
      editor.applyExternalContent(
        'test-note',
        'Me: [[shopping list]]\n',
        (window as unknown as FakeHostWindow).__futoTest.documentRef().generation,
      );
    },
    JSON.stringify([{ id: 'shopping list', title: 'shopping list', modifiedMs: 0 }]),
  );
  await flushFrames(page);
  await expect(chip(page)).toHaveText('shopping list');
  await expect(chip(page)).not.toHaveClass(/cm-md-wikilink-broken/);
  await settleChangeDebounce(page);
  expect(await getContent(page)).toBe('Me: [[shopping list]]\n');
});

// ============================================================
// The acceptance criterion: syntax survives a real edit
// ============================================================

test('opening a note with wikilinks never rewrites it', async ({ page }) => {
  const source = 'See [[Projects/Roadmap]] and [[nope]].\n';
  await open(page, source);
  await settleChangeDebounce(page);
  expect(await getContent(page)).toBe(source);
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

test('a real edit still writes the wikilink unescaped', async ({ page }) => {
  await open(page, 'See [[Projects/Roadmap]].\n');
  await focusEditor(page);
  await goToEnd(page);
  await page.keyboard.type(' Done.');
  const [change] = await waitForMessages(page, 'change');

  // Without the serializer half this reads `See \[\[Projects/Roadmap]].`
  expect(change.content).toContain('[[Projects/Roadmap]]');
  expect(change.content).not.toContain('\\[\\[');
  expect(await getContent(page)).toContain('[[Projects/Roadmap]]');
});

test('an edit elsewhere leaves every other wikilink byte-identical', async ({ page }) => {
  await open(page, '# Notes\n\n[[a|b]] [[a]b]] [[a*b*c]] [[Über/naïve]]\n');
  await focusEditor(page);
  await goToEnd(page);
  await page.keyboard.type('!');
  const [change] = await waitForMessages(page, 'change');
  for (const link of ['[[a|b]]', '[[a]b]]', '[[a*b*c]]', '[[Über/naïve]]']) {
    expect(change.content).toContain(link);
  }
});

// ============================================================
// Navigation
// ============================================================

test('tapping a resolved wikilink posts openNote with the RESOLVED id', async ({ page }) => {
  await open(page, 'Go to [[ideas]] now.\n');
  await clearMessages(page);
  await chip(page).tap();
  const [openNote] = await waitForMessages(page, 'openNote');
  // The link says "ideas"; the host is handed the note id it resolves to.
  expect(openNote.id).toBe('work/notes/ideas');
});

test('one tap posts openNote exactly once', async ({ page }) => {
  await open(page, '[[ideas]]\n');
  await clearMessages(page);
  await chip(page).tap();
  await waitForMessages(page, 'openNote');
  await page.waitForTimeout(200);
  expect(await messagesOfType(page, 'openNote')).toHaveLength(1);
});

test('clicking a resolved wikilink posts openNote', async ({ page }) => {
  await open(page, '[[ideas]]\n');
  await clearMessages(page);
  await chip(page).click();
  const [openNote] = await waitForMessages(page, 'openNote');
  expect(openNote.id).toBe('work/notes/ideas');
});

test('middle-clicking a resolved wikilink posts openNote', async ({ page }) => {
  await open(page, '[[ideas]]\n');
  await clearMessages(page);
  await chip(page).click({ button: 'middle' });
  const [openNote] = await waitForMessages(page, 'openNote');
  expect(openNote.id).toBe('work/notes/ideas');
});

test('tapping a broken wikilink posts nothing', async ({ page }) => {
  // The embed posts openNote only for a resolved link.
  await open(page, '[[no such note]]\n');
  await clearMessages(page);
  await chip(page).tap();
  await page.waitForTimeout(300);
  expect(await messagesOfType(page, 'openNote')).toHaveLength(0);
});

test('a broken wikilink tap stays available to the editor, so the chip can be replaced', async ({
  page,
}) => {
  // The chip is an atom: it is repaired by SELECTING and replacing it, not by
  // editing inside it. Consuming the tap (as a resolved link does) would leave
  // a dead chip that can be neither followed nor fixed.
  await open(page, '[[no such note]]\n');
  await chip(page).tap();
  await page.keyboard.type('x');
  const [change] = await waitForMessages(page, 'change');
  expect(change.content).not.toContain('[[no such note]]');
});

test('a resolved wikilink tap is consumed, not turned into a caret placement', async ({ page }) => {
  await open(page, '[[ideas]]\n');
  await chip(page).tap();
  await waitForMessages(page, 'openNote');
  await page.keyboard.type('x');
  await settleChangeDebounce(page);
  // Following a link must not also edit the note you are leaving.
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

test('an external link still leaves through openUrl, not openNote', async ({ page }) => {
  await open(page, '[site](https://example.com)\n');
  await clearMessages(page);
  await page.locator('.ProseMirror a[href]').tap();
  const [openUrl] = await waitForMessages(page, 'openUrl');
  expect(openUrl.url).toBe('https://example.com');
  expect(await messagesOfType(page, 'openNote')).toHaveLength(0);
});

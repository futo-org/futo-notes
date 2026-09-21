import { expect, test as base, type Page } from '@playwright/test';

import { BRIDGE_VERSION } from '@futo-notes/editor';

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

/** @milkdown/plugin-listener debounces `markdownUpdated` by 200 ms (trailing). */
const CHANGE_DEBOUNCE_MS = 200;

const VAULT = [
  { id: 'Projects/Roadmap', title: 'Roadmap', modifiedMs: 3 },
  { id: 'Archive/2024/Roadmap', title: 'Roadmap', modifiedMs: 2 },
  { id: 'grocery list', title: 'grocery list', modifiedMs: 1 },
  { id: 'work/notes/ideas', title: 'ideas', modifiedMs: 0 },
];

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

async function settleChangeDebounce(page: Page): Promise<void> {
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 80);
  await flushFrames(page);
}

/** Boots the bundle exactly as a native host does: one `initialize` call. */
async function open(
  page: Page,
  content: string,
  notes: typeof VAULT | null = VAULT,
): Promise<void> {
  const config = JSON.stringify({
    bridgeVersion: BRIDGE_VERSION,
    theme: 'light',
    content,
    nativeToolbar: true,
    contentPaddingInlinePx: 14,
    ...(notes ? { notesJson: JSON.stringify(notes) } : {}),
  });
  await page.evaluate(
    (json) => (window as unknown as FakeHostWindow).FutoEditor.initialize(json),
    config,
  );
  await flushFrames(page);
}

const chip = (page: Page) => page.locator('.ProseMirror a[data-wikilink]');

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
      editor.applyExternalContent('Link to [[work/notes/plans]].\n');
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
      editor.applyExternalContent('Me: [[shopping list]]\n');
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
  await page.keyboard.press('End');
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
  await page.keyboard.press('End');
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

test('tapping a broken wikilink posts nothing', async ({ page }) => {
  // The recorded native Gap: the embed posts openNote only for a resolved link.
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

// ============================================================
// `[[` autocomplete
// ============================================================

const popup = (page: Page) => page.locator('.futo-wikilink-suggest');
const rows = (page: Page) => popup(page).locator('li');

test('typing `[[` opens the whole note list', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[');
  await expect(rows(page)).toHaveCount(VAULT.length);
});

test('typing filters the list case-insensitively', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[road');
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText('Projects/Roadmap');
});

test('Enter inserts the FULL path and leaves the caret AFTER the link', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[ideas');
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(popup(page)).toBeHidden();

  // Typing continues past the link, not inside it — the spec's caret rule.
  await page.keyboard.type(' next');
  const [change] = await waitForMessages(page, 'change');
  expect(change.content).toBe('[[work/notes/ideas]] next\n');
  // What the reader sees is still the short form.
  await expect(chip(page)).toHaveText('ideas');
});

test('arrow keys move the highlighted row and Enter takes it', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[road');
  await expect(rows(page).nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  const [change] = await waitForMessages(page, 'change');
  expect(change.content).toBe('[[Archive/2024/Roadmap]]\n');
});

test('tapping a row inserts that note', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[groc');
  await rows(page).first().tap();
  const [change] = await waitForMessages(page, 'change');
  expect(change.content).toBe('[[grocery list]]\n');
});

test('Escape closes the popup and keeps it closed while the run is typed', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[road');
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup(page)).toBeHidden();
  await page.keyboard.type('m');
  await expect(popup(page)).toBeHidden();
});

test('`[[` inside inline code never opens the popup', async ({ page }) => {
  // docs/spec/editor.md: wikilinks inside inline code are not decorated and not
  // extracted — so autocomplete must not offer to write one there either.
  await open(page, 'text `code` tail\n');
  await focusEditor(page);
  await page.keyboard.press('End');
  /* Land BETWEEN two characters of the span, not on its edge: code marks are
   * non-inclusive, so a caret at the closing edge is genuinely outside the
   * span and typing there is not code. " tail" is 5, plus 2 into "code". */
  for (let i = 0; i < 7; i += 1) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('[[');
  await expect(popup(page)).toBeHidden();
});

test('typing a full wikilink inside inline code leaves it as text', async ({ page }) => {
  await open(page, '`abc`\n');
  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('[[grocery list]]');
  const [change] = await waitForMessages(page, 'change');
  expect(await chip(page).count()).toBe(0);
  expect(change.content).toContain('[[grocery list]]');
});

test('Escape is remembered across a query that matches nothing', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[road');
  await page.keyboard.press('Escape');
  await expect(popup(page)).toBeHidden();
  // A no-match query used to forget the dismissal, so backspacing reopened it.
  await page.keyboard.type('zzz');
  await expect(popup(page)).toBeHidden();
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Backspace');
  await expect(popup(page)).toBeHidden();
});

test('a query that matches nothing shows no popup', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[zzzz');
  await expect(popup(page)).toBeHidden();
});

test('typing a wikilink out in full turns into a link on the closing brackets', async ({
  page,
}) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[grocery list');
  await page.keyboard.press('Escape');
  await page.keyboard.type(']]');
  await expect(chip(page)).toHaveText('grocery list');
  const [change] = await waitForMessages(page, 'change');
  expect(change.content).toBe('[[grocery list]]\n');
});

// ============================================================
// A `!` that starts no embed (issue #112)
// ============================================================

/**
 * The `![[embed]]` lookahead used to open its `wikilink` token before it knew a
 * `[[` followed, and consuming the end of the input stranded that token open —
 * so the enclosing paragraph or table cell could never close, the parse threw,
 * and the note opened BLANK on every shell. The reference note that could not
 * be opened at all was a table with `no!!` in a header cell.
 *
 * The unit differential (`wikilink/syntax.test.ts`) locks the grammar; this
 * asks the only question the user has — does the note open, and is it still the
 * same note afterwards.
 */
const BANG_TABLE = '| a | no!! |\n| - | ---- |\n| x | y    |\n';

test('a table whose header cell ends in `!` opens instead of throwing', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  await open(page, BANG_TABLE);

  // The note RENDERED: a real table, not the blank editor a thrown parse leaves.
  await expect(page.locator('.ProseMirror table')).toHaveCount(1);
  await expect(page.locator('.ProseMirror table th').nth(1)).toHaveText('no!!');
  expect(crashes).toEqual([]);
  // And opening it did not rewrite it.
  expect(await getContent(page)).toBe(BANG_TABLE);
});

test('a paragraph ending in `!` opens and round-trips', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  // The headline shape from the issue: the `!` is the last thing on the line.
  const source = 'What a note!\n\nAnd another one!\n';
  await open(page, source);

  await expect(page.locator('.ProseMirror p').first()).toHaveText('What a note!');
  expect(crashes).toEqual([]);
  expect(await getContent(page)).toBe(source);
});

test('the `!` lookahead still claims the bang in front of a real embed', async ({ page }) => {
  // The construct's whole reason to exist: without it micromark's image label
  // eats `![` and the surviving `[` cannot start a wikilink.
  await open(page, '![[Projects/Roadmap]]\n');
  await expect(chip(page)).toHaveText('Projects/Roadmap');
});

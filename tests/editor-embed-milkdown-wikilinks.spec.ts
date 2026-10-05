import { expect, test as base, type Locator, type Page } from '@playwright/test';

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
  withCaretObserved,
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

/**
 * One key that moves the caret, returning only once ProseMirror has read the new
 * caret out of the DOM (`withCaretObserved`). `page.keyboard.press` resolves in
 * ~2 ms but the browser reports the caret to ProseMirror on the next rendering
 * update, so on a loaded runner the next key (or the typed `[[`) acted on the
 * PREVIOUS caret: RC-100 saw the popup open because the caret was still outside
 * the code span. The key MUST really move the caret, or there is nothing to
 * wait for.
 */
async function moveCaret(page: Page, key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await withCaretObserved(page, () => page.keyboard.press(key));
  }
}

/**
 * `End` after `focusEditor`. The caret may already BE at the end (`focus()` leaves
 * it there for a one-paragraph note), so no selection change is guaranteed and
 * `withCaretObserved` would wait for ever: settle on rendering frames instead,
 * which is when the browser reports a pending caret to ProseMirror.
 */
async function goToEnd(page: Page): Promise<void> {
  await page.keyboard.press('End');
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
    noteId: 'test-note',
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

/**
 * Wait until the markdown the editor last REPORTED is `expected`. The
 * listener's 200 ms trailing debounce posts the half-typed `[[road` on its own
 * whenever the waits between keystrokes outlast it, as they do on a busy CI
 * runner, so the first `change` message is not necessarily the final one.
 */
async function expectReported(page: Page, expected: string): Promise<void> {
  await expect
    .poll(async () => (await messagesOfType(page, 'change')).at(-1)?.content)
    .toBe(expected);
}

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
  await expectReported(page, '[[work/notes/ideas]] next\n');
  // What the reader sees is still the short form.
  await expect(chip(page)).toHaveText('ideas');
});

/** Puts the caret at the end of `target`'s text with a real click just right of it. */
async function clickLineEnd(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('clickLineEnd: target is not visible');
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
}

test('Enter accepts the suggestion inside a CHECKED task item instead of splitting it', async ({
  page,
}) => {
  // The direct `handleKeyDown` of keyboardParity.ts claims Enter in a checked
  // task ("split, new item unchecked"); it runs before the popup's own keymap,
  // so the suggestion used to be left as literal `\[\[ideas` and an empty item
  // was added underneath (RC-20).
  await open(page, '- [x] done\n');
  await clickLineEnd(page, page.locator('.ProseMirror li p'));
  await page.keyboard.type('[[ideas');
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(popup(page)).toBeHidden();
  // The trailing blank line after a list is a separate known serializer quirk
  // (RC-22), so pin the item line itself: accepted in place, no second item.
  await expect
    .poll(async () => (await messagesOfType(page, 'change')).at(-1)?.content?.trimEnd())
    .toBe('- [x] done[[work/notes/ideas]]');
});

test('Enter accepts the suggestion inside a table cell instead of moving the caret', async ({
  page,
}) => {
  // Same Enter-claim family as above: the table's Enter (move down / append a
  // row) used to win over the popup.
  await open(page, '| a | b |\n| - | - |\n| c | d |\n');
  await clickLineEnd(page, page.locator('.ProseMirror tr:last-child td:last-child p'));
  await page.keyboard.type('[[ideas');
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(popup(page)).toBeHidden();
  // The table serializer pads columns to the widest cell; pin the cell.
  await expect
    .poll(async () => (await messagesOfType(page, 'change')).at(-1)?.content)
    .toContain('| c | d[[work/notes/ideas]] |\n');
});

test('arrow keys move the highlighted row and Enter takes it', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[road');
  await expect(rows(page).nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expectReported(page, '[[Archive/2024/Roadmap]]\n');
});

test('tapping a row inserts that note', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[groc');
  await rows(page).first().tap();

  // Typing `[[groc` is itself a debounced edit, and the tap right behind it
  // is a second, independent one — on a slower/contended CI runner the gap
  // between them can exceed the debounce window, so the TYPING's own change
  // can post (with the pre-tap `[[groc` text) before the tap's insertion
  // does. Grabbing "the first 'change' message" then reads the wrong one, no
  // matter how long the wait. Wait for the specific content the tap
  // produces instead — the condition this test actually cares about.
  await page.waitForFunction(() => {
    const w = window as unknown as FakeHostWindow & {
      __msgs: { type: string; content?: string }[];
    };
    return w.__msgs.some((m) => m.type === 'change' && m.content === '[[grocery list]]\n');
  });
  const changes = await messagesOfType(page, 'change');
  expect(changes.at(-1)?.content).toBe('[[grocery list]]\n');
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
  await goToEnd(page);
  /* Land BETWEEN two characters of the span, not on its edge: code marks are
   * non-inclusive, so a caret at the closing edge is genuinely outside the
   * span and typing there is not code. " tail" is 5, plus 2 into "code". */
  await moveCaret(page, 'ArrowLeft', 7);
  await page.keyboard.type('[[');
  await expect(popup(page)).toBeHidden();
  /* `toBeHidden` alone passes before a popup could ever appear, and would pass
   * just as well if the caret had missed the span. Prove the premise: the
   * brackets went INTO the code span. */
  await settleChangeDebounce(page);
  expect(await getContent(page)).toBe('text `co[[de` tail\n');
  await expect(popup(page)).toBeHidden();
});

test('typing a full wikilink inside inline code leaves it as text', async ({ page }) => {
  await open(page, '`abc`\n');
  await focusEditor(page);
  await goToEnd(page);
  await moveCaret(page, 'ArrowLeft', 2);
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
  await expectReported(page, '[[grocery list]]\n');
});

test('a wikilink typed with a `|` in a table cell keeps its row and its link', async ({ page }) => {
  // A GFM row is split on every unescaped `|` before inline parsing, so the
  // handler has to write `[[note\\|alias]]` in a cell. Written raw, the next
  // open split the cell, and the next edit widened the table and escaped the
  // link into `\\[\\[note` text (hardening L6e-15).
  await open(page, '| a | b |\n| - | - |\n| c | d |\n');
  await withCaretObserved(page, () => page.getByText('c', { exact: true }).click());
  await goToEnd(page); // the click may already have left the caret at the end
  await page.keyboard.type(' [[note|alias');
  await page.keyboard.press('Escape');
  await page.keyboard.type(']]');
  await expect(chip(page)).toHaveCount(1);
  await settleChangeDebounce(page);
  const saved = await getContent(page);
  expect(saved).toContain('| c [[note\\|alias]] | d |');

  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', '-'),
  );
  await page.evaluate(
    (m) => (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', m),
    saved,
  );
  await flushFrames(page);
  const cells = page.locator('.ProseMirror tr').nth(1).locator('td, th');
  await expect(cells, saved).toHaveCount(2);
  await expect(chip(page)).toHaveCount(1);
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

// ============================================================
// IME next to a chip (FB-19, L6f-2)
// ============================================================

/**
 * Milkdown's `inlineNodesCursorPlugin` gives a caret that sits between two
 * non-text inline nodes (two chips, image + chip) somewhere to live, and owns
 * the whole composition there. Upstream's `compositionend` handler returned
 * `true`, which is "handled" — so ProseMirror's own `compositionend` never ran,
 * `view.composing` stayed `true` after the commit and, off Android (where the
 * 5 s composition timeout does not exist), stayed that way until the next
 * composition. Markdown input rules stop while it is set (`- ` typed at the start
 * of a line stays literal), and the host's `isComposing()` — sync deferral, the
 * selection toolbar — reads the same flag.
 *
 * The IME is driven through CDP (`Input.imeSetComposition` + `Input.insertText`):
 * the only way to make Chromium fire the real composition events. Chromium-only,
 * which is the only project this config has.
 */
interface ComposingViewWindow {
  __futoProseMirrorView: () => {
    composing: boolean;
    focus(): void;
    state: {
      doc: {
        content: { size: number };
        firstChild: { nodeSize: number };
        resolve(pos: number): unknown;
        descendants(
          visit: (
            node: { isInline: boolean; isText: boolean },
            pos: number,
            parent: { child(index: number): { isInline: boolean; isText: boolean } },
            index: number,
          ) => boolean | void,
        ): void;
      };
      selection: { constructor: { near(pos: unknown): unknown } };
      tr: { setSelection(selection: unknown): unknown };
    };
    dispatch(tr: unknown): void;
  };
}

type CaretSpot = 'between-chips' | 'line-start' | 'line-end';

/** Positions the caret (a selection, not input) and focuses the editor. */
async function placeCaret(page: Page, spot: CaretSpot): Promise<void> {
  await page.evaluate((where) => {
    const view = (window as unknown as ComposingViewWindow).__futoProseMirrorView();
    const doc = view.state.doc;
    let pos = -1;
    if (where === 'line-start') pos = 1;
    else if (where === 'line-end') pos = doc.firstChild.nodeSize - 1;
    else
      doc.descendants((node, at, parent, index) => {
        if (pos >= 0) return false;
        if (node.isInline && !node.isText && index > 0) {
          const before = parent.child(index - 1);
          if (before.isInline && !before.isText) pos = at;
        }
        return true;
      });
    if (pos < 0) throw new Error('no such caret position in the document');
    view.dispatch(
      view.state.tr.setSelection(view.state.selection.constructor.near(doc.resolve(pos))),
    );
    view.focus();
  }, spot);
}

/**
 * Selects `count` consecutive inline atoms (chips / images), skipping the first
 * `skip`, and focuses the editor. One atom is a NodeSelection, as a tap or an
 * arrow key makes it; more are the text range a drag makes.
 */
async function selectAtoms(page: Page, skip: number, count: number): Promise<void> {
  await page.evaluate(
    ({ skip: skipped, count: n }) => {
      const view = (window as unknown as ComposingViewWindow).__futoProseMirrorView();
      const doc = view.state.doc;
      const at: number[] = [];
      doc.descendants((node, pos) => {
        if (node.isInline && !node.isText) at.push(pos);
        return true;
      });
      const from = at[skipped];
      const last = at[skipped + n - 1];
      if (from === undefined || last === undefined) throw new Error('no such chip in the document');
      const Selection = Object.getPrototypeOf(view.state.selection.constructor) as {
        fromJSON(doc: unknown, json: unknown): unknown;
      };
      const json =
        n === 1 ? { type: 'node', anchor: from } : { type: 'text', anchor: from, head: last + 1 };
      view.dispatch(view.state.tr.setSelection(Selection.fromJSON(doc, json)));
      view.focus();
    },
    { skip, count },
  );
}

const composing = (page: Page) =>
  page.evaluate(() => (window as unknown as ComposingViewWindow).__futoProseMirrorView().composing);

/** A pinyin-style composition that commits `commit`, through the real IME path. */
async function imeCommit(page: Page, steps: string[], commit: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  for (const text of steps)
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  await cdp.send('Input.insertText', { text: commit });
  await flushFrames(page);
  // The plugin re-inserts the committed text from a rAF; let that land.
  await page.waitForTimeout(100);
  await flushFrames(page);
}

const OCCURRENCES = (text: string, needle: string) => text.split(needle).length - 1;

test.describe('IME commit next to a chip', () => {
  const BETWEEN: Record<string, string> = {
    'two chips': 'para\n\na [[one]][[two]] z\n\nlast\n',
    'an image and a chip': 'para\n\na ![pic](pic.png)[[two]] z\n\nlast\n',
  };

  for (const [shape, markdown] of Object.entries(BETWEEN)) {
    test(`between ${shape}: lands once, composing clears, input rules still run`, async ({
      page,
    }) => {
      await open(page, markdown);
      await placeCaret(page, 'between-chips');
      await imeCommit(page, ['ni', 'nihao'], 'NIHAO');

      const after = await getContent(page);
      expect(OCCURRENCES(after, 'NIHAO')).toBe(1);
      expect(after).not.toMatch(/nihao|ni(?!hao)/);
      // The committed text sits between the two nodes, not before or after them.
      expect(after).toMatch(/[\])]NIHAO\[\[two\]\]/);
      expect.soft(await composing(page)).toBe(false);

      // `- ` at the start of a fresh line is a bullet again: the input rule does
      // not run while `view.composing` is stuck.
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('- item');
      await flushFrames(page);
      await expect(page.locator('.ProseMirror ul li')).toHaveCount(1);
      expect(await getContent(page)).toContain('- item');
    });
  }

  test('plain typing between two chips still lands once', async ({ page }) => {
    await open(page, 'a [[one]][[two]] z\n');
    await placeCaret(page, 'between-chips');
    await page.keyboard.type('QQ');
    await flushFrames(page);
    const after = await getContent(page);
    expect(OCCURRENCES(after, 'QQ')).toBe(1);
    expect(after).toContain('[[one]]QQ[[two]]');
  });

  test('a second composition in the next gap commits as cleanly as the first', async ({ page }) => {
    await open(page, 'a [[one]][[two]][[three]] z\n');
    await placeCaret(page, 'between-chips');
    await imeCommit(page, ['ni', 'nihao'], 'NIHAO');
    expect(await composing(page)).toBe(false);
    // The first gap now holds text; the next adjacent pair is [[two]][[three]].
    await placeCaret(page, 'between-chips');
    await imeCommit(page, ['sh', 'shijie'], 'SHIJIE');
    expect(await getContent(page)).toContain('[[one]]NIHAO[[two]]SHIJIE[[three]]');
    expect(await composing(page)).toBe(false);
  });

  test('at the start of a line, in front of a chip', async ({ page }) => {
    await open(page, '[[one]] z\n');
    await placeCaret(page, 'line-start');
    await imeCommit(page, ['ni', 'nihao'], 'NIHAO');
    const after = await getContent(page);
    expect(OCCURRENCES(after, 'NIHAO')).toBe(1);
    expect(after).toContain('NIHAO[[one]]');
    expect(await composing(page)).toBe(false);
  });

  test('at the end of a line, behind a chip', async ({ page }) => {
    await open(page, 'a [[one]]\n');
    await placeCaret(page, 'line-end');
    await imeCommit(page, ['ni', 'nihao'], 'NIHAO');
    const after = await getContent(page);
    expect(OCCURRENCES(after, 'NIHAO')).toBe(1);
    expect(after).toContain('[[one]]NIHAO');
    expect(await composing(page)).toBe(false);
  });

  // R10-FB19-1. The fork's re-insert runs a frame after the commit. A candidate
  // pick that commits a prefix and keeps composing starts the next composition
  // inside that frame, with the caret still "between" the nodes, so the plugin's
  // `lock` was set for a composition ProseMirror reads natively from then on:
  // its compositionend inserted the text a second time. Two frames' worth of
  // delay is made deterministic by slowing requestAnimationFrame to 30 ms.
  async function slowFrames(page: Page, ms: number): Promise<void> {
    await page.evaluate((delay) => {
      window.requestAnimationFrame = (cb) =>
        window.setTimeout(() => cb(performance.now()), delay) as unknown as number;
    }, ms);
  }

  async function composeInGap(page: Page): Promise<import('@playwright/test').CDPSession> {
    const cdp = await page.context().newCDPSession(page);
    for (const text of ['ni', 'nihao'])
      await cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    return cdp;
  }

  // Chromium drops a live composition silently when the selection or the nodes
  // around it change under it (no compositionend), and the IME then carries on
  // with a fresh composition: that is the sequence below.
  async function continueComposition(cdp: import('@playwright/test').CDPSession): Promise<void> {
    await cdp.send('Input.imeSetComposition', {
      text: 'nihao',
      selectionStart: 5,
      selectionEnd: 5,
    });
    await cdp.send('Input.insertText', { text: 'NIHAO' });
  }

  test('a prefix commit that keeps composing does not duplicate the next commit', async ({
    page,
  }) => {
    await open(page, 'pre [[one]][[two]] post\n');
    await slowFrames(page, 30);
    await placeCaret(page, 'between-chips');
    const cdp = await page.context().newCDPSession(page);
    const compose = async (text: string) => {
      await cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
      await page.waitForTimeout(120);
    };
    await compose('ni');
    await compose('nihao');
    await cdp.send('Input.insertText', { text: '你' });
    await compose('hao');
    await compose('haos');
    await compose('haoshi');
    await cdp.send('Input.insertText', { text: '好世' });
    await compose('jie');
    await cdp.send('Input.insertText', { text: '界' });
    await page.waitForTimeout(200);
    await flushFrames(page);
    expect(await getContent(page)).toContain('[[one]]你好世界[[two]]');
    expect(await composing(page)).toBe(false);
  });

  test('a chip deleted mid-composition does not duplicate the commit', async ({ page }) => {
    await open(page, 'pre [[one]][[two]] post\n');
    await placeCaret(page, 'between-chips');
    const cdp = await composeInGap(page);
    await page.evaluate(() => {
      const view = (
        window as unknown as {
          __futoProseMirrorView: () => {
            state: { selection: { from: number }; tr: { delete(a: number, b: number): unknown } };
            dispatch(tr: unknown): void;
          };
        }
      ).__futoProseMirrorView();
      const at = view.state.selection.from;
      // The chip to the left of the gap, removed by something other than the IME.
      view.dispatch(view.state.tr.delete(at - 1, at));
    });
    await continueComposition(cdp);
    await flushFrames(page);
    await page.waitForTimeout(100);
    const after = await getContent(page);
    expect(OCCURRENCES(after, 'NIHAO')).toBe(1);
    expect(await composing(page)).toBe(false);
  });

  test('a selection moved mid-composition does not duplicate the commit', async ({ page }) => {
    await open(page, 'pre [[one]][[two]] post\n');
    await placeCaret(page, 'between-chips');
    const cdp = await composeInGap(page);
    await placeCaret(page, 'line-end');
    await continueComposition(cdp);
    await flushFrames(page);
    await page.waitForTimeout(100);
    const after = await getContent(page);
    expect(OCCURRENCES(after, 'NIHAO')).toBe(1);
    expect(await composing(page)).toBe(false);
  });

  // RC-97 (FB-19's refuter). A chip that is SELECTED (a NodeSelection: tapped, or
  // reached by an arrow key) and composed over: the IME replaces the selection
  // with the composed text. ProseMirror re-dispatched the selection as a text
  // range under the live composition, Chromium dropped the composition without a
  // `compositionend`, and the commit was lost, the chip stayed and
  // `view.composing` stayed set.
  const SELECTED: Array<[string, string, number, number, string]> = [
    ['a chip', 'pre [[one]] post\n', 0, 1, 'pre NIHAO post'],
    [
      'the middle one of three chips',
      'a [[one]][[two]][[three]] z\n',
      1,
      1,
      '[[one]]NIHAO[[three]]',
    ],
    ['an image', 'pre ![pic](pic.png) post\n', 0, 1, 'pre NIHAO post'],
    ['two chips as a text range', 'pre [[one]][[two]] post\n', 0, 2, 'pre NIHAO post'],
  ];
  for (const [what, markdown, skip, count, expected] of SELECTED) {
    test(`composing over ${what} replaces it and ends the composition`, async ({ page }) => {
      await open(page, markdown);
      await selectAtoms(page, skip, count);
      await imeCommit(page, ['ni', 'nihao'], 'NIHAO');
      const after = await getContent(page);
      expect(OCCURRENCES(after, 'NIHAO')).toBe(1);
      expect(after).toContain(expected);
      expect(after).not.toContain('[[one]][[two]]');
      expect.soft(await composing(page)).toBe(false);
      // Input rules run again: `- ` at the start of a fresh line is a bullet.
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('- item');
      await flushFrames(page);
      await expect(page.locator('.ProseMirror ul li')).toHaveCount(1);
    });
  }

  test('ordinary text is unchanged: commit lands once and composing clears', async ({ page }) => {
    await open(page, 'hello world\n');
    await placeCaret(page, 'line-end');
    await imeCommit(page, ['ni', 'nihao'], 'NIHAO');
    const after = await getContent(page);
    expect(after).toBe('hello worldNIHAO\n');
    expect(await composing(page)).toBe(false);
  });

  test('a character typed right after the commit keeps its order', async ({ page }) => {
    await open(page, 'a [[one]][[two]] z\n');
    await placeCaret(page, 'between-chips');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', {
      text: 'hello',
      selectionStart: 5,
      selectionEnd: 5,
    });
    await cdp.send('Input.insertText', { text: 'hello' });
    // The next character arrives before the plugin's re-insert has run.
    await page.keyboard.type('X');
    await flushFrames(page);
    await page.waitForTimeout(100);
    expect(await getContent(page)).toContain('[[one]]helloX[[two]]');
  });
});

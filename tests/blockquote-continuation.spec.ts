import { test, expect, Page } from '@playwright/test';

async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-editor', { timeout: 10000 });
  await page.waitForSelector('.cm-content', { timeout: 10000 });
}

async function typeInEditor(page: Page, text: string): Promise<void> {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.type(text);
}

/** Get the raw document text from the CodeMirror EditorView */
async function getDocText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content');
    if (!content) return '';
    const tile = (content as any).cmTile;
    const view = tile?.root?.view;
    return view?.state?.doc?.toString() ?? '';
  });
}

/** Get the text of the line the cursor is on */
async function getCursorLine(page: Page): Promise<string> {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content');
    if (!content) return '';
    const tile = (content as any).cmTile;
    const view = tile?.root?.view;
    if (!view) return '';
    const pos = view.state.selection.main.from;
    return view.state.doc.lineAt(pos).text;
  });
}

/** Get the cursor's character offset within the current line */
async function getCursorOffset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content');
    if (!content) return -1;
    const tile = (content as any).cmTile;
    const view = tile?.root?.view;
    if (!view) return -1;
    const pos = view.state.selection.main.from;
    const line = view.state.doc.lineAt(pos);
    return pos - line.from;
  });
}

test.describe('Blockquote Continuation', () => {

  // ===== LEVEL 1 CONTINUATION =====

  test('Enter after level-1 quote continues with "> " (with space)', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '> hello');
    await page.keyboard.press('Enter');

    const curLine = await getCursorLine(page);
    expect(curLine).toBe('> ');
  });

  test('level-1 continuation places cursor after "> "', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '> hello');
    await page.keyboard.press('Enter');

    const offset = await getCursorOffset(page);
    expect(offset).toBe(2); // after "> "
  });

  test('typing after level-1 continuation appends to the quote line', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '> hello');
    await page.keyboard.press('Enter');
    await page.keyboard.type('world');

    const curLine = await getCursorLine(page);
    expect(curLine).toBe('> world');
  });

  // ===== LEVEL 2 CONTINUATION =====

  test('Enter after level-2 quote continues with "> > " (spaces at every level)', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '>> hello');
    await page.keyboard.press('Enter');

    const curLine = await getCursorLine(page);
    expect(curLine).toBe('> > ');
  });

  test('level-2 continuation places cursor after "> > "', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '>> hello');
    await page.keyboard.press('Enter');

    const offset = await getCursorOffset(page);
    expect(offset).toBe(4); // after "> > "
  });

  test('Enter after "> > hello" (spaced format) also continues at level 2', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '> > hello');
    await page.keyboard.press('Enter');

    const curLine = await getCursorLine(page);
    expect(curLine).toBe('> > ');
  });

  // ===== LEVEL 3 CONTINUATION =====

  test('Enter after level-3 quote continues with "> > > "', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '>>> deep');
    await page.keyboard.press('Enter');

    const curLine = await getCursorLine(page);
    expect(curLine).toBe('> > > ');
  });

  // ===== TAB NESTING =====

  test('Tab on a blockquote line nests it one level deeper', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '> hello');
    await page.keyboard.press('Tab');

    const curLine = await getCursorLine(page);
    const offset = await getCursorOffset(page);
    expect(curLine).toBe('> > hello');
    expect(offset).toBe('> > hello'.length);
  });

  test('Shift+Tab on a nested blockquote line steps it back one level', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '> > hello');
    await page.keyboard.press('Shift+Tab');

    const curLine = await getCursorLine(page);
    const offset = await getCursorOffset(page);
    expect(curLine).toBe('> hello');
    expect(offset).toBe('> hello'.length);
  });

  // ===== EXIT VIA DOUBLE-ENTER (LEVEL 1) =====

  test('Enter twice on level-1 exits blockquote — line becomes empty', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '> hello');
    await page.keyboard.press('Enter'); // continuation: "> "
    await page.keyboard.press('Enter'); // empty quote line → exit

    const curLine = await getCursorLine(page);
    expect(curLine).toBe('');
  });

  // ===== STEP-DOWN VIA DOUBLE-ENTER (LEVEL 2) =====

  test('Enter twice on level-2 steps down to level 1, not full exit', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '>> hello');
    await page.keyboard.press('Enter'); // continuation: "> > "
    await page.keyboard.press('Enter'); // empty level-2 → step down to "> "

    const curLine = await getCursorLine(page);
    expect(curLine).toBe('> ');
  });

  test('Enter three times on level-2 fully exits blockquote', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '>> hello');
    await page.keyboard.press('Enter'); // continuation: "> > "
    await page.keyboard.press('Enter'); // step down to "> "
    await page.keyboard.press('Enter'); // exit

    const curLine = await getCursorLine(page);
    expect(curLine).toBe('');
  });

  // ===== STEP-DOWN VIA DOUBLE-ENTER (LEVEL 3) =====

  test('Enter twice on level-3 steps down to level 2', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '>>> deep');
    await page.keyboard.press('Enter'); // continuation: "> > > "
    await page.keyboard.press('Enter'); // step down to "> > "

    const curLine = await getCursorLine(page);
    expect(curLine).toBe('> > ');
  });

  test('Enter four times on level-3 fully exits blockquote', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '>>> deep');
    await page.keyboard.press('Enter'); // "> > > "
    await page.keyboard.press('Enter'); // "> > "
    await page.keyboard.press('Enter'); // "> "
    await page.keyboard.press('Enter'); // exit

    const curLine = await getCursorLine(page);
    expect(curLine).toBe('');
  });

  // ===== CONTENT PRESERVATION =====

  test('continuation preserves original line content', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '> hello');
    await page.keyboard.press('Enter');

    const doc = await getDocText(page);
    expect(doc).toContain('> hello');
  });

  test('typing after level-2 continuation then Enter stays at level 2', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '>> first');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second');
    await page.keyboard.press('Enter');

    const curLine = await getCursorLine(page);
    expect(curLine).toBe('> > ');
  });
});

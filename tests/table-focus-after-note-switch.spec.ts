import { test, expect, Page } from '@playwright/test';

const TABLE = '| A | B |\n| --- | --- |\n| x | y |';
const NOTE_A = `intro paragraph\n\n${TABLE}\n`;

async function waitForApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!(window as { __testNotes?: unknown }).__testNotes, null, {
    timeout: 10000,
  });
}

async function createTestNote(page: Page, title: string, body: string): Promise<void> {
  await page.evaluate(
    async ({ title, body }) => {
      const api = (window as { __testNotes?: { createNote(t: string, b: string): Promise<void> } })
        .__testNotes;
      if (!api) throw new Error('__testNotes not available — is dev mode running?');
      await api.createNote(title, body);
    },
    { title, body },
  );
}

/** In-app switch, exactly as clicking a note does: `page.goto` would reload and take the
 * editor's focus with it, which is the state this regression is about. */
async function openNote(page: Page, id: string, settledDoc: string): Promise<void> {
  await page.evaluate((noteId) => {
    window.location.hash = `#/note/${encodeURIComponent(noteId)}`;
  }, id);
  await page.waitForSelector('.cm-content', { timeout: 10000 });
  await page.waitForFunction(
    (expected) =>
      (window as { __cmGetView?: () => { state: { doc: { toString(): string } } } | null })
        .__cmGetView?.()
        ?.state.doc.toString() === expected,
    settledDoc,
    { timeout: 10000 },
  );
}

test.describe('interactive table after a note switch', () => {
  test('a table under the restored caret stays in source form', async ({ page }) => {
    await waitForApp(page);
    await createTestNote(page, 'Table note', NOTE_A);
    await createTestNote(page, 'Other note', 'beta');

    await openNote(page, 'Table note', NOTE_A);
    await page.evaluate(() => {
      const view = (
        window as {
          __cmGetView?: () => {
            focus(): void;
            dispatch(spec: unknown): void;
            state: { doc: { toString(): string } };
          } | null;
        }
      ).__cmGetView?.();
      if (!view) throw new Error('no editor view');
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('x') } });
    });
    await expect(page.locator('.sf-table')).toHaveCount(0);

    // Switch away and back without ever leaving the editor: the whole-state swap used to
    // hand the table field a state that believed the editor was unfocused.
    await openNote(page, 'Other note', 'beta');
    await openNote(page, 'Table note', NOTE_A);

    expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain(
      'cm-content',
    );
    await expect(page.locator('.sf-table')).toHaveCount(0);
    await expect(page.locator('.cm-content')).toContainText('| --- | --- |');
  });
});

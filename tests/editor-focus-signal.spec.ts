/**
 * The app's editor-focus SIGNAL, driven by real focus.
 *
 * `session.editorFocused` decides whether an incoming peer/external change is
 * adopted now or parked until blur, and `onfocuschange` is what tells the shell to
 * settle a parked one (`NotesShell.handleEditorFocusChange` →
 * `createExternalChangeCoordinator.handleEditorFocusChange`). Both halves have
 * coverage on either side of this file and none of it uses real focus:
 *
 *   - the coordinator's decisions are unit-tested against a mocked session
 *     (createExternalChangeCoordinator.test.ts),
 *   - the cross-platform desktop mesh drives a SYNTHETIC focus flag, because two
 *     Tauri windows cannot both hold OS focus (tauri-test-client focusEditor),
 *   - the Android leg has genuine device focus but exercises the Kotlin shell.
 *
 * So the desktop chain from a real click to the shell's focus callback was
 * unexercised end to end. This is where it is: a real browser window, real
 * pointer clicks, real CM6 focus/blur events, asserted at each hop.
 *
 * What it deliberately does NOT reach: the disposition itself. `classifyOpenNote`
 * is a Tauri command (the engine reads disk inside it), so deferral and adoption
 * can only be exercised in a real shell — desktop with the synthetic flag, Android
 * with real focus.
 */
import { test, expect, Page } from '@playwright/test';

async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-editor', { timeout: 10000 });
  await page.waitForSelector('.cm-content', { timeout: 10000 });
}

/** What the app itself believes about editor focus — the value
 *  `session.editorFocused` reads, not a flag the test wrote. */
function appReportedFocus(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as typeof window & {
      __notesShellTest: { isEditorFocused: () => boolean };
    };
    return w.__notesShellTest.isEditorFocused();
  });
}

test.describe('Editor focus signal', () => {
  test('a real click focuses the editor and the shell hears about it', async ({ page }) => {
    await openNewNote(page);
    // Start blurred: a fresh note focuses the title, not the body.
    await page.locator('.title-input').click();
    await expect(page.locator('.note-body')).not.toHaveAttribute('data-editor-focused', '');
    expect(await appReportedFocus(page)).toBe(false);

    // A real pointer click in the note body — the only input that produces a
    // genuine CM6 focus event plus a focused document.
    await page.locator('.cm-content').click();

    // CM6 itself, the app's own focus read, and the workspace's reactive state
    // fed by `onfocuschange` — the same callback the shell hands
    // `handleEditorFocusChange`, so its firing is what this observes.
    await expect(page.locator('.cm-editor')).toHaveClass(/cm-focused/);
    await expect(page.locator('.note-body')).toHaveAttribute('data-editor-focused', '');
    expect(await appReportedFocus(page)).toBe(true);

    // …and a real blur takes all three back, which is the edge that settles a
    // deferred adoption.
    await page.locator('.title-input').click();

    await expect(page.locator('.cm-editor')).not.toHaveClass(/cm-focused/);
    await expect(page.locator('.note-body')).not.toHaveAttribute('data-editor-focused', '');
    expect(await appReportedFocus(page)).toBe(false);
  });
});

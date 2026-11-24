import type { Page } from '@playwright/test';

/**
 * The desktop shell's editor, for Playwright specs.
 *
 * `.desktop-editor` is the editable element the desktop editor mounts
 * (`features/editor/desktop/view.ts`).
 *
 * Read the note through `editorMarkdown`, never off the DOM: the editor renders
 * WYSIWYG, so `innerText` is what the reader sees and the markdown is what gets
 * saved. Specs almost always mean the second one.
 */
export const EDITOR = '.desktop-editor';

interface TestHookWindow {
  __notesShellTest?: {
    getState: () => { editorContent: string };
    typeInEditor: (text: string) => string;
    seedOpenNote: (id: string, body: string) => void;
    flushSave: () => Promise<void>;
  };
}

/** Wait for the editor to be mounted AND for the shell's test hook to exist. */
export async function waitForEditor(page: Page): Promise<void> {
  await page.waitForSelector(EDITOR, { timeout: 10_000 });
  await page.waitForFunction(
    () => Boolean((window as unknown as TestHookWindow).__notesShellTest),
    null,
    { timeout: 10_000 },
  );
}

/**
 * A new note focuses its editor one animation frame after it mounts
 * (`createNoteLoader` finishNewNote). Until that frame runs, focus a spec gives
 * the title is taken away mid-typing: `test` became title `t` and body `est`,
 * often enough on a loaded runner to fail CI.
 */
async function waitForNewNoteFocus(page: Page): Promise<void> {
  await page.waitForFunction(
    (selector) => document.activeElement?.closest(selector) != null,
    EDITOR,
    { timeout: 10_000 },
  );
}

export async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await waitForEditor(page);
  await waitForNewNoteFocus(page);
}

/** The note's markdown, exactly as the editor would hand it to a save. */
export async function editorMarkdown(page: Page): Promise<string> {
  return page.evaluate(
    () => (window as unknown as TestHookWindow).__notesShellTest?.getState().editorContent ?? '',
  );
}

/**
 * Wait until the note's markdown settles on `expected`.
 *
 * Compared with trailing newlines stripped from BOTH sides: whether the note
 * ends in a newline is not what a caller means to assert on.
 * `withoutTrailingBlank` is the same rule, exported for specs that read the
 * note directly.
 */
export async function waitForMarkdown(page: Page, expected: string): Promise<void> {
  await page.waitForFunction(
    (want) => {
      const live =
        (window as unknown as TestHookWindow).__notesShellTest?.getState().editorContent ?? '';
      return live.replace(/\n+$/, '') === want.replace(/\n+$/, '');
    },
    expected,
    { timeout: 10_000 },
  );
}

/**
 * Open a new note WITHOUT reloading the page, so in-memory test state (notes
 * injected through `__testNotes._injectTestNote`) survives. `openNewNote` does
 * a full `page.goto`, which wipes it.
 */
export async function openNewNoteInPlace(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/note/new';
  });
  await waitForEditor(page);
  await waitForNewNoteFocus(page);
}

/** Replace the whole note: select all, then the hook's insert over the selection. */
export async function setEditorMarkdown(page: Page, markdown: string): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+a');
  if (markdown === '') {
    await page.keyboard.press('Backspace');
    return;
  }
  await page.evaluate((md) => {
    const hook = (window as unknown as TestHookWindow).__notesShellTest;
    if (!hook) throw new Error('__notesShellTest not available — is dev mode running?');
    hook.typeInEditor(md);
  }, markdown);
}

/**
 * Focus without moving the caret. A click would place it where the click
 * landed, which several specs set up deliberately beforehand.
 */
export async function focusEditor(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    document.querySelector<HTMLElement>(selector)?.focus();
  }, EDITOR);
}

/** Per-keystroke delay for `typeInEditor`: well inside human cadence. */
export const TYPE_DELAY_MS = 40;

/** Click into the editor and type at a person's cadence. */
export async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.locator(EDITOR).click();
  await page.keyboard.type(text, { delay: TYPE_DELAY_MS });
}

/** Type at the caret, without clicking first (which would move it). */
export async function typeAtCaret(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: TYPE_DELAY_MS });
}

/**
 * Empty the note the way a user does: click in, select all, delete.
 * `Ctrl+A` reads the document, not the caret, so it is safe straight after the
 * click.
 */
export async function clearEditorWithKeyboard(page: Page): Promise<void> {
  await page.locator(EDITOR).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
}

/** The note without its trailing newlines: specs that assert a whole document want it so. */
export function withoutTrailingBlank(markdown: string): string {
  return markdown.replace(/\n+$/, '');
}

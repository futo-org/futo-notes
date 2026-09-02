import type { Page } from '@playwright/test';

/**
 * The desktop shell's editor, for Playwright specs.
 *
 * `.ProseMirror` is the editable element `MilkdownEditor.svelte` mounts — the
 * same component the native shells run inside `editor.html`, so a behavior
 * asserted here is the behavior on every platform.
 *
 * Read the note through `editorMarkdown`, never off the DOM: the editor renders
 * WYSIWYG, so `innerText` is what the reader sees and the markdown is what gets
 * saved. Specs almost always mean the second one.
 */
export const EDITOR = '.ProseMirror';

interface TestHookWindow {
  __notesShellTest?: {
    getState: () => { editorContent: string };
    typeInEditor: (text: string) => string;
    replaceEditorContent: (content: string) => string;
    seedOpenNote: (id: string, body: string) => void;
    flushSave: () => Promise<void>;
  };
}

/** Wait for the editor to be mounted AND for the shell's test hook to exist. */
export async function waitForEditor(page: Page): Promise<void> {
  await page.waitForSelector('.futo-milkdown', { timeout: 10_000 });
  await page.waitForSelector(EDITOR, { timeout: 10_000 });
  await page.waitForFunction(
    () => Boolean((window as unknown as TestHookWindow).__notesShellTest),
    null,
    { timeout: 10_000 },
  );
}

export async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await waitForEditor(page);
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
 * Compared with trailing blank lines stripped from BOTH sides: the editor
 * always keeps one empty paragraph at the end of the document so the bottom of
 * a note stays tappable, and it serializes as a trailing newline that no caller
 * means to assert on. `withoutTrailingBlank` is the same rule, exported for
 * specs that read the note directly.
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
}

/** Replace the whole note, as one undoable edit. */
export async function setEditorMarkdown(page: Page, markdown: string): Promise<void> {
  await page.evaluate((md) => {
    const hook = (window as unknown as TestHookWindow).__notesShellTest;
    if (!hook) throw new Error('__notesShellTest not available — is dev mode running?');
    hook.replaceEditorContent(md);
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

/**
 * Per-keystroke delay for `typeInEditor`.
 *
 * Playwright's default `type()` has NO delay, which outruns ProseMirror's input
 * rules: `> ` and `- ` are recognised in a transaction that has to land before
 * the next character arrives, so a zero-delay `'> hello'` produces a quote whose
 * text never got in. 40 ms is well inside human cadence and was measured to be
 * enough (a 120 ms run produces the same document).
 */
export const TYPE_DELAY_MS = 40;

/** Click into the editor and type at a cadence the input rules can keep up with. */
export async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.locator(EDITOR).click();
  await page.keyboard.type(text, { delay: TYPE_DELAY_MS });
}

/** Type at the caret, without clicking first (which would move it). */
export async function typeAtCaret(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: TYPE_DELAY_MS });
}

/**
 * The editor always keeps one empty trailing paragraph so the end of a note is
 * tappable, which serializes as a trailing blank line. Specs that assert a whole
 * document want the note without it.
 */
export function withoutTrailingBlank(markdown: string): string {
  return markdown.replace(/\n+$/, '');
}

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

/** Wait until the note's markdown settles on `expected`. */
export async function waitForMarkdown(page: Page, expected: string): Promise<void> {
  await page.waitForFunction(
    (want) =>
      (window as unknown as TestHookWindow).__notesShellTest?.getState().editorContent === want,
    expected,
    { timeout: 10_000 },
  );
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

/** Click into the editor and type — a real user's keystrokes. */
export async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.locator(EDITOR).click();
  await page.keyboard.type(text);
}

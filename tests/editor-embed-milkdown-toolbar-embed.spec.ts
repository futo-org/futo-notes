// Part of the Milkdown toolbar suite: the parity model is described in
// editor-embed-milkdown-toolbar.spec.ts.

import { expect, type Page } from '@playwright/test';
import { BRIDGE_VERSION } from '@futo-notes/editor';
import { focusEditor, getContent, type FakeHostWindow } from './lib/editorEmbedHost';
import { test, settle, selectAll } from './lib/editorEmbedMilkdownToolbar';

// ============================================================
// The embed fallback toolbar — the same commands, tapped for real
// ============================================================

/**
 * The web toolbar the embed renders on hosts that do NOT set
 * `nativeToolbar` (`EmbedToolbar.svelte`). Everything above drives `exec()`
 * the way the native shells do; this drives the buttons themselves, so the
 * fallback's own dispatch and active-state rendering are covered rather than
 * assumed.
 */
async function showEmbedToolbar(page: Page, markdown: string): Promise<void> {
  await page.evaluate(
    (json) => (window as unknown as FakeHostWindow).FutoEditor.initialize(json),
    JSON.stringify({
      bridgeVersion: BRIDGE_VERSION,
      noteId: 'test-note',
      theme: 'light',
      content: markdown,
      nativeToolbar: false,
      contentPaddingInlinePx: 14,
    }),
  );
  await focusEditor(page);
  await expect(page.locator('.markdown-toolbar')).toBeVisible();
}

function toolbarButton(page: Page, label: string) {
  return page.locator('.markdown-toolbar').getByRole('button', { name: label, exact: true });
}

test('tapping the embed toolbar runs the same command exec does', async ({ page }) => {
  await showEmbedToolbar(page, 'hello');
  await toolbarButton(page, 'Bullet list').click();
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('- hello');

  await toolbarButton(page, 'Bullet list').click();
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('hello');
});

test('the embed toolbar highlights the command active at the caret', async ({ page }) => {
  await showEmbedToolbar(page, 'hello');
  const quoteButton = toolbarButton(page, 'Block quote');
  await expect(quoteButton).not.toHaveClass(/is-active/);

  await quoteButton.click();
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('> hello');
  await expect(quoteButton).toHaveClass(/is-active/);

  await quoteButton.click();
  await settle(page);
  await expect(quoteButton).toHaveClass(/is-active/);
  expect((await getContent(page)).trimEnd()).toBe('> hello');

  await toolbarButton(page, 'Outdent').click();
  await settle(page);
  await expect(quoteButton).not.toHaveClass(/is-active/);
});

test('the embed toolbar grays out Undo/Redo when their stacks are empty, and blocks the tap', async ({
  page,
}) => {
  await showEmbedToolbar(page, 'hello');
  const undoButton = toolbarButton(page, 'Undo');
  const redoButton = toolbarButton(page, 'Redo');
  await expect(undoButton).toHaveClass(/is-disabled/);
  await expect(redoButton).toHaveClass(/is-disabled/);
  await expect(undoButton).toBeDisabled();
  await expect(redoButton).toBeDisabled();

  await selectAll(page);
  await toolbarButton(page, 'Bold').click();
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('**hello**');
  await expect(undoButton).not.toHaveClass(/is-disabled/);
  await expect(redoButton).toHaveClass(/is-disabled/);

  await undoButton.click();
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('hello');
  await expect(undoButton).toHaveClass(/is-disabled/);
  await expect(redoButton).not.toHaveClass(/is-disabled/);
});

test('the embed toolbar shows Indent/Outdent inside a list or quote', async ({ page }) => {
  await showEmbedToolbar(page, 'hello');
  await expect(toolbarButton(page, 'Indent')).toHaveCount(0);

  await toolbarButton(page, 'Bullet list').click();
  await settle(page);
  await expect(toolbarButton(page, 'Indent')).toBeVisible();

  await toolbarButton(page, 'Block quote').click();
  await settle(page);
  await expect(toolbarButton(page, 'Indent')).toBeVisible();
  await toolbarButton(page, 'Outdent').click();
  await settle(page);
  await expect(toolbarButton(page, 'Indent')).toHaveCount(0);
});

// A caret merely NAVIGATED into an already-existing quote (never created via
// the toolbar in this session) — the reported bug: on mobile the button never
// appeared for a caret inside a quote at all.
test('the embed toolbar shows Indent/Outdent for a caret navigated into an existing quote', async ({
  page,
}) => {
  await showEmbedToolbar(page, '> hello');
  await page.evaluate(() => document.querySelector<HTMLElement>('.ProseMirror')?.focus());
  await page.keyboard.press('End');
  await settle(page);
  await expect(toolbarButton(page, 'Indent')).toBeVisible();
});

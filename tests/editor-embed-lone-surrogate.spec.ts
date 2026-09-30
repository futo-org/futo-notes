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
  type FakeHostWindow,
} from './lib/editorEmbedHost';

/**
 * A lone UTF-16 surrogate never leaves the editor (RC-48, maintainer decision 16A).
 *
 * Before the fix, one in the document reached the Tauri IPC as a `\ud800` JSON
 * escape; on WebKitGTK the host's parser dropped the message without answering, so
 * the save never settled and the note could not be left. The editor now writes each
 * lone surrogate as U+FFFD in `getContent()` and in the `change` report, the two
 * ways text leaves it (tests/desktop-lone-surrogate.mjs holds the desktop end).
 *
 * How a lone surrogate can get in is the open question, so each way is a test:
 *   - a paste carrying one (a dispatched ClipboardEvent — the limit of the tool);
 *   - `execCommand('insertText')`, the DOM edit a keyboard or IME makes;
 *   - the host handing one over (`setContent`, `applyExternalContent`);
 *   - and the real-key case that SHOULD be safe: Backspace over an emoji.
 */

const HIGH = '\ud83d';
const LOW = '\ude00';
const EMOJI = HIGH + LOW;
const FFFD = String.fromCharCode(0xfffd);

function isWellFormed(text: string): boolean {
  return text.toWellFormed() === text;
}

const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({ hasTouch: true });
    await context.addInitScript(installFakeAndroidHost);
    const page = await context.newPage();
    await page.goto(EDITOR_URL);
    await page.waitForFunction(() =>
      (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
    );
    await page.evaluate(
      (json) => (window as unknown as FakeHostWindow).FutoEditor.initialize(json),
      JSON.stringify({
        bridgeVersion: BRIDGE_VERSION,
        theme: 'light',
        content: '',
        nativeToolbar: true,
        contentPaddingInlinePx: 14,
      }),
    );
    await flushFrames(page);
    await use(page);
    await context.close();
  },
});

async function hostSetContent(page: Page, markdown: string): Promise<void> {
  await page.evaluate(
    (md) => (window as unknown as FakeHostWindow).FutoEditor.setContent(md),
    markdown,
  );
  await flushFrames(page);
}

/** The last `change` the host was sent, waiting for the 200 ms report debounce. */
async function lastChange(page: Page): Promise<string> {
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs.some((m) => m.type === 'change'),
  );
  const changes = await messagesOfType(page, 'change');
  return changes[changes.length - 1].content as string;
}

async function pasteText(page: Page, text: string): Promise<void> {
  await page.evaluate((data) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', data);
    document
      .querySelector('.ProseMirror')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
  }, text);
}

test('a paste carrying a lone surrogate reads back as U+FFFD, in getContent and in the change report', async ({
  page,
}) => {
  await hostSetContent(page, 'start');
  await focusEditor(page);
  await page.keyboard.press('End');
  await clearMessages(page);

  await pasteText(page, ` a${HIGH}b`);

  const content = await getContent(page);
  expect(content).toContain(`a${FFFD}b`);
  expect(isWellFormed(content)).toBe(true);
  const reported = await lastChange(page);
  expect(reported).toContain(`a${FFFD}b`);
  expect(isWellFormed(reported)).toBe(true);
});

test('a lone low surrogate from execCommand insertText reads back as U+FFFD', async ({ page }) => {
  await hostSetContent(page, 'start');
  await focusEditor(page);
  await page.keyboard.press('End');
  await clearMessages(page);

  const inserted = await page.evaluate(
    (text) => document.execCommand('insertText', false, text),
    `x${LOW}y`,
  );
  expect(inserted).toBe(true);

  const content = await getContent(page);
  expect(content).toContain(`x${FFFD}y`);
  expect(isWellFormed(content)).toBe(true);
  expect(isWellFormed(await lastChange(page))).toBe(true);
});

// The engine's own text-insertion command (what dictation, an emoji picker and an IME commit call).
// WebKit puts half an emoji into the DOM as given (measured: the document then holds a lone
// U+D83D); Chromium turns it into U+FFFD before the page sees it. Either way nothing ill-formed
// leaves the editor.
test('keyboard.insertText of half an emoji never leaves the editor as a lone surrogate', async ({
  page,
}) => {
  await hostSetContent(page, 'start');
  await focusEditor(page);
  await page.keyboard.press('End');
  await clearMessages(page);

  await page.keyboard.insertText(HIGH);

  const content = await getContent(page);
  expect(isWellFormed(content)).toBe(true);
  expect(content).toContain('start');
  expect(isWellFormed(await lastChange(page))).toBe(true);
});

test('a document the host hands over with a lone surrogate never reads back with one', async ({
  page,
}) => {
  await hostSetContent(page, `host ${HIGH} text`);
  expect(await getContent(page)).toBe(`host ${FFFD} text`);
  await page.evaluate(
    (md) => (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent(md),
    `peer ${LOW} text`,
  );
  await flushFrames(page);
  expect(await getContent(page)).toBe(`peer ${FFFD} text`);
});

test('a valid emoji pair survives untouched', async ({ page }) => {
  await hostSetContent(page, 'start');
  await focusEditor(page);
  await page.keyboard.press('End');
  await pasteText(page, ` ${EMOJI}!`);
  for (const text of [await getContent(page), await lastChange(page)]) {
    expect(text.trimEnd()).toBe(`start${EMOJI}!`);
    expect(text).not.toContain(FFFD);
  }
});

test('Backspace over an emoji removes the whole pair and never leaves half of one', async ({
  page,
}) => {
  await hostSetContent(page, `one ${EMOJI}`);
  await focusEditor(page);
  await page.keyboard.press('End');
  await clearMessages(page);

  await page.keyboard.press('Backspace');

  const content = await getContent(page);
  expect(isWellFormed(content)).toBe(true);
  expect(content.trimEnd()).toBe('one');
  expect(isWellFormed(await lastChange(page))).toBe(true);
});

test('without String.prototype.toWellFormed (an old WebView) the scan fallback repairs the same text', async ({
  browser,
}) => {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(() => {
    delete (String.prototype as { toWellFormed?: unknown }).toWellFormed;
    delete (String.prototype as { isWellFormed?: unknown }).isWellFormed;
  });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(EDITOR_URL);
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  expect(await page.evaluate(() => typeof ''.toWellFormed)).toBe('undefined');
  await hostSetContent(page, `a${HIGH}b ${EMOJI} c${LOW}d`);
  expect(await getContent(page)).toBe(`a${FFFD}b ${EMOJI} c${FFFD}d`);
  await context.close();
});

import { expect, test, type CDPSession, type Page } from '@playwright/test';

import { EDITOR_URL } from './editorEmbedBundle';
import { flushFrames, getContent, openEmbed, type FakeHostWindow } from './lib/editorEmbedHost';
import { hostConfig, initialize } from './lib/editorEmbedSpec';
import { caretAtEndOf } from './lib/editorEmbedMilkdownInteractive';

/**
 * Enter pressed while the keyboard is still composing a word, on Android's
 * WebView (#277).
 *
 * The keyboard's return key reaches the page as a keydown with keyCode 13 while
 * the word is still a composition, and the commit follows it. ProseMirror never
 * acts on that keydown on Chrome-Android: it leaves Enter to the paragraph the
 * browser makes, and reads that back as an Enter. When the browser makes none
 * (the keydown carries no character, so no `insertParagraph` follows), the
 * Enter was simply lost: "type `one`, tap return, nothing happens".
 *
 * The IME is driven through CDP (`Input.imeSetComposition` + `Input.insertText`),
 * the only way to make Chromium fire real composition events, and the return key
 * through `Input.dispatchKeyEvent` — a `rawKeyDown` carries no character, which
 * is the captured shape of the lost Enter; a `keyDown` with `\r` is the shape a
 * browser does split for. The user agent is an Android WebView's, because the
 * editor's Enter path on Android is chosen from it.
 */
const ANDROID_WEBVIEW =
  'Mozilla/5.0 (Linux; Android 16; sdk_gphone64_x86_64 Build/BE2A.250530.026.F3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/133.0.6943.137 Mobile Safari/537.36';

const ENTER = {
  key: 'Enter',
  code: 'Enter',
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 66,
};

async function openWith(
  browser: import('@playwright/test').Browser,
  content: string,
  userAgent: string | undefined,
): Promise<{ page: Page; cdp: CDPSession; close: () => Promise<void> }> {
  const { context, page } = await openEmbed(browser, EDITOR_URL, userAgent ? { userAgent } : {});
  await initialize(page, hostConfig({ content }));
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('ControlOrMeta+End');
  const cdp = await context.newCDPSession(page);
  return { page, cdp, close: () => context.close() };
}

/** Composes `steps` as one word at the caret, leaving the composition open. */
async function compose(cdp: CDPSession, steps: string[]): Promise<void> {
  for (const text of steps)
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
}

/** The return key while composing: `withChar` decides whether the browser splits. */
async function returnKey(cdp: CDPSession, withChar: boolean): Promise<void> {
  await cdp.send(
    'Input.dispatchKeyEvent',
    withChar
      ? { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...ENTER }
      : { type: 'rawKeyDown', ...ENTER },
  );
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
}

async function settle(page: Page): Promise<void> {
  await flushFrames(page);
  await page.waitForTimeout(150);
  await flushFrames(page);
}

const composing = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as FakeHostWindow & {
          __futoProseMirrorView: () => { composing: boolean };
        }
      ).__futoProseMirrorView().composing,
  );

test.describe('Android: return key while a word is composing', () => {
  test('a lone first word in an empty note, committed after the key: one newline', async ({
    browser,
  }) => {
    const { page, cdp, close } = await openWith(browser, '', ANDROID_WEBVIEW);
    await compose(cdp, ['o', 'on', 'one']);
    await returnKey(cdp, false);
    // The keyboard commits the word after the key, capitalised.
    await cdp.send('Input.insertText', { text: 'One' });
    await settle(page);
    expect(await composing(page)).toBe(false);
    await page.keyboard.type('two');
    await settle(page);
    expect(await getContent(page)).toBe('One\ntwo\n');
    await close();
  });

  test('a word composing at the end of a line of text', async ({ browser }) => {
    const { page, cdp, close } = await openWith(browser, 'alpha', ANDROID_WEBVIEW);
    await page.keyboard.type(' ');
    await compose(cdp, ['b', 'be', 'beta']);
    await returnKey(cdp, false);
    await cdp.send('Input.insertText', { text: 'beta' });
    await settle(page);
    await page.keyboard.type('gamma');
    await settle(page);
    expect(await getContent(page)).toBe('alpha beta\ngamma\n');
    await close();
  });

  test('a word composing in a list item continues the list', async ({ browser }) => {
    const { page, cdp, close } = await openWith(browser, '- first', ANDROID_WEBVIEW);
    // Not the end of the document: that is the empty line the editor keeps after a list.
    await caretAtEndOf(page, 'first');
    await page.keyboard.type(' ');
    await compose(cdp, ['w', 'wo', 'word']);
    await returnKey(cdp, false);
    await cdp.send('Input.insertText', { text: 'word' });
    await settle(page);
    await page.keyboard.type('second');
    await settle(page);
    expect(await getContent(page)).toBe('- first word\n- second\n');
    await close();
  });

  test('a word composing in a heading starts a paragraph after it', async ({ browser }) => {
    const { page, cdp, close } = await openWith(browser, '# Title', ANDROID_WEBVIEW);
    await page.keyboard.type(' ');
    await compose(cdp, ['w', 'wo', 'word']);
    await returnKey(cdp, false);
    await cdp.send('Input.insertText', { text: 'word' });
    await settle(page);
    await page.keyboard.type('body');
    await settle(page);
    expect(await getContent(page)).toBe('# Title word\n\nbody\n');
    await close();
  });

  test('an autocorrection replacing the word as it commits', async ({ browser }) => {
    const { page, cdp, close } = await openWith(browser, '', ANDROID_WEBVIEW);
    await compose(cdp, ['t', 'te', 'teh']);
    await returnKey(cdp, false);
    await cdp.send('Input.insertText', { text: 'The' });
    await settle(page);
    await page.keyboard.type('next');
    await settle(page);
    expect(await getContent(page)).toBe('The\nnext\n');
    await close();
  });

  test('when the browser splits the line itself, Enter still lands once', async ({ browser }) => {
    const { page, cdp, close } = await openWith(browser, '', ANDROID_WEBVIEW);
    await compose(cdp, ['o', 'on', 'one']);
    // The split commits the word itself; the keyboard has nothing left to commit.
    await returnKey(cdp, true);
    await settle(page);
    await page.keyboard.type('two');
    await settle(page);
    expect(await getContent(page)).toBe('one\ntwo\n');
    await close();
  });

  test('the return key with nothing composing is one newline', async ({ browser }) => {
    const { page, close } = await openWith(browser, 'one', ANDROID_WEBVIEW);
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await settle(page);
    expect(await getContent(page)).toBe('one\ntwo\n');
    await close();
  });
});

/**
 * Off Android, a return key that arrives inside a composition confirms the
 * composition (a CJK candidate, say) and is not a newline: the fallback above
 * must stay Android-only.
 */
test('desktop: the return key inside a composition only confirms it', async ({ browser }) => {
  const { page, cdp, close } = await openWith(browser, '', undefined);
  await compose(cdp, ['ni', 'nihao']);
  await returnKey(cdp, false);
  await cdp.send('Input.insertText', { text: 'NIHAO' });
  await settle(page);
  expect(await getContent(page)).toBe('NIHAO\n');
  await close();
});

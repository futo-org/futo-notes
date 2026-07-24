import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { test as base, expect, type Page } from '@playwright/test';

import { EDITOR_BUNDLE_PATH, EDITOR_URL } from './editorEmbedBundle';

/**
 * futoBridge v6 protocol contract — executable.
 *
 * This drives the SAME single-file `editor.html` bundle the native iOS/Android
 * shells ship (built by `vite.editor.config.ts`) with a FAKE host installed
 * before any page script runs, and asserts the full editor-embed <-> host
 * message contract defined in `packages/editor/src/bridge.ts` and the prose in
 * `docs/spec/editor.md`. It covers BOTH host transports:
 *
 *   - Android: `window.futoBridge.postMessage(jsonString)` (the primary path
 *     these tests record from).
 *   - iOS: `window.webkit.messageHandlers.futoBridge.postMessage(object)`,
 *     which `postToHost` prefers when both are present (one dedicated test).
 *
 * SCOPE, stated honestly: this is a PROTOCOL / LOGIC contract exercised in
 * headless Chromium. It deliberately does NOT prove WKWebView or Android
 * WebView keyboard behavior, IME/composition, soft-keyboard docking, or scroll
 * / momentum physics — on-device QA still owns those (see the many
 * "Verified emulator + simulator" notes in docs/spec/editor.md). What it locks
 * is the message wiring, the echo-suppression invariant, the shared toolbar
 * commands, link routing, image paste, theming, and toolbar suppression.
 *
 * Real user input uses Playwright keyboard / touchscreen — never synthetic DOM
 * `click()`, which does not fire Svelte 5 / CodeMirror handlers (AGENTS.md
 * M21). Selections are probed by typing a sentinel and reading `getContent()`,
 * because the production bundle does not expose CodeMirror's dev `__cmGetView`
 * hook (`import.meta.env.DEV` is false in a release build).
 */

interface BridgeMessage {
  type: string;
  [key: string]: unknown;
}

interface FakeHostWindow extends Window {
  __msgs: BridgeMessage[];
  __openCalls: unknown[][];
  FutoEditor: {
    setContent(markdown: string): void;
    getContent(): string;
    focus(): void;
    blur(): void;
    setTheme(theme: 'light' | 'dark'): void;
    setNotes(notesJson: string): void;
    applyExternalContent(markdown: string): void;
    insertImage(filename: string): void;
    setImageBaseUrl(base: string): void;
    exec(commandId: string): void;
    setNativeToolbar(enabled: boolean): void;
  };
}

// Installed via addInitScript BEFORE the bundle's own scripts, so the very
// first `ready` post lands in `__msgs`. Also stubs `window.open` so a test can
// prove external links never fall back to it while a host is present.
function installFakeAndroidHost(): void {
  const w = window as unknown as FakeHostWindow;
  w.__msgs = [];
  w.__openCalls = [];
  w.open = ((...args: unknown[]) => {
    w.__openCalls.push(args);
    return null;
  }) as typeof window.open;
  (w as unknown as { futoBridge: { postMessage(json: string): void } }).futoBridge = {
    postMessage: (json: string) => w.__msgs.push(JSON.parse(json) as BridgeMessage),
  };
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
    await use(page);
    await context.close();
  },
});

// Let the editor's rAF-coalesced change callback flush before we assert.
async function flushFrames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

function messages(page: Page): Promise<BridgeMessage[]> {
  return page.evaluate(() => (window as unknown as FakeHostWindow).__msgs);
}

async function messagesOfType(page: Page, type: string): Promise<BridgeMessage[]> {
  return (await messages(page)).filter((m) => m.type === type);
}

async function clearMessages(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as FakeHostWindow).__msgs.length = 0;
  });
}

function getContent(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.getContent());
}

// Set the whole document from the host, then let the (suppressed) change
// callback flush so the echo-suppression flag is consumed before we type.
async function hostSetContent(page: Page, markdown: string): Promise<void> {
  await page.evaluate(
    (md) => (window as unknown as FakeHostWindow).FutoEditor.setContent(md),
    markdown,
  );
  await flushFrames(page);
}

async function exec(page: Page, commandId: string): Promise<void> {
  await page.evaluate((id) => (window as unknown as FakeHostWindow).FutoEditor.exec(id), commandId);
  await flushFrames(page);
}

// ============================================================
// Handshake — ready message and transport routing
// ============================================================

test('posts ready exactly once with bridge version 6', async ({ page }) => {
  const ready = await messagesOfType(page, 'ready');
  expect(ready).toHaveLength(1);
  expect(ready[0].version).toBe(6);
});

test('prefers the iOS webkit transport when both hosts are present', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(() => {
    const w = window as unknown as {
      __ios: BridgeMessage[];
      __android: BridgeMessage[];
      webkit: { messageHandlers: { futoBridge: { postMessage(m: BridgeMessage): void } } };
      futoBridge: { postMessage(json: string): void };
    };
    w.__ios = [];
    w.__android = [];
    w.webkit = { messageHandlers: { futoBridge: { postMessage: (m) => w.__ios.push(m) } } };
    w.futoBridge = { postMessage: (json) => w.__android.push(JSON.parse(json) as BridgeMessage) };
  });
  const page = await context.newPage();
  await page.goto(EDITOR_URL);
  await page.waitForFunction(() =>
    (window as unknown as { __ios: BridgeMessage[] }).__ios.some((m) => m.type === 'ready'),
  );

  const ios = await page.evaluate(() => (window as unknown as { __ios: BridgeMessage[] }).__ios);
  const android = await page.evaluate(
    () => (window as unknown as { __android: BridgeMessage[] }).__android,
  );
  expect(ios.filter((m) => m.type === 'ready')).toHaveLength(1);
  expect(ios[0].version).toBe(6);
  expect(android).toHaveLength(0);

  await context.close();
});

// ============================================================
// Content sync — setContent / getContent + the echo invariant
// ============================================================

test('setContent then getContent round-trips the document', async ({ page }) => {
  await hostSetContent(page, 'Hello world');
  expect(await getContent(page)).toBe('Hello world');
});

test('a host-initiated setContent posts no change', async ({ page }) => {
  await clearMessages(page);
  await hostSetContent(page, 'Set by the host');
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

test('a real keystroke posts exactly one change with the new content', async ({ page }) => {
  await hostSetContent(page, 'Hello world');
  await clearMessages(page);

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await page.keyboard.press('End');
  await page.keyboard.type('X');
  await flushFrames(page);

  const changes = await messagesOfType(page, 'change');
  expect(changes).toHaveLength(1);
  expect(changes[0].content).toBe('Hello worldX');
});

test('applyExternalContent adopts differing content without a change echo', async ({ page }) => {
  await hostSetContent(page, 'original');
  await clearMessages(page);

  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent('adopted from a peer'),
  );
  await flushFrames(page);

  expect(await getContent(page)).toBe('adopted from a peer');
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

test('applyExternalContent with unchanged content preserves the selection', async ({ page }) => {
  await hostSetContent(page, 'abcdef');
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await clearMessages(page);

  // No-op adopt (content identical): must not reset the caret to 0.
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent('abcdef'),
  );
  await flushFrames(page);
  await page.keyboard.type('Z');
  await flushFrames(page);

  expect(await getContent(page)).toBe('abcZdef');
});

// ============================================================
// exec(id) — the 11 shared TOOLBAR_EXEC commands
// ============================================================

async function execInline(page: Page, text: string, commandId: string): Promise<string> {
  await hostSetContent(page, text);
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await page.keyboard.press('Control+a');
  await exec(page, commandId);
  return getContent(page);
}

async function execOnLine(page: Page, text: string, commandId: string): Promise<string> {
  await hostSetContent(page, text);
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await exec(page, commandId);
  return getContent(page);
}

test('exec bold wraps the selection in **', async ({ page }) => {
  expect(await execInline(page, 'word', 'bold')).toBe('**word**');
});

test('exec italic wraps the selection in *', async ({ page }) => {
  expect(await execInline(page, 'word', 'italic')).toBe('*word*');
});

test('exec strikethrough wraps the selection in ~~', async ({ page }) => {
  expect(await execInline(page, 'word', 'strikethrough')).toBe('~~word~~');
});

test('exec heading prefixes the line with #', async ({ page }) => {
  expect(await execOnLine(page, 'hello', 'heading')).toBe('# hello');
});

test('exec quote prefixes the line with >', async ({ page }) => {
  expect(await execOnLine(page, 'hello', 'quote')).toBe('> hello');
});

test('exec bullet-list toggles a - marker', async ({ page }) => {
  expect(await execOnLine(page, 'hello', 'bullet-list')).toBe('- hello');
});

test('exec ordered-list toggles a 1. marker', async ({ page }) => {
  expect(await execOnLine(page, 'hello', 'ordered-list')).toBe('1. hello');
});

test('exec task-list toggles a - [ ] marker', async ({ page }) => {
  expect(await execOnLine(page, 'hello', 'task-list')).toBe('- [ ] hello');
});

test('exec link wraps a selection as [sel]() with the caret in the URL slot', async ({ page }) => {
  await hostSetContent(page, 'word');
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await page.keyboard.press('Control+a');
  await exec(page, 'link');
  expect(await getContent(page)).toBe('[word]()');

  // Typing lands inside the parentheses -> URL slot.
  await page.keyboard.type('U');
  await flushFrames(page);
  expect(await getContent(page)).toBe('[word](U)');
});

test('exec link with no selection inserts the []() scaffold', async ({ page }) => {
  await hostSetContent(page, '');
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await exec(page, 'link');
  expect(await getContent(page)).toBe('[]()');

  // Current behavior for the empty-scaffold case: the caret lands in the TEXT
  // slot (between the brackets), not the URL slot. Locked as-is.
  await page.keyboard.type('T');
  await flushFrames(page);
  expect(await getContent(page)).toBe('[T]()');
});

test('exec indent then outdent adjusts a list line', async ({ page }) => {
  await hostSetContent(page, '- item');
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());

  await exec(page, 'indent');
  expect(await getContent(page)).toMatch(/^\s+- item$/);

  await exec(page, 'outdent');
  expect(await getContent(page)).toBe('- item');
});

test('exec ignores an unknown command id without mutating the document', async ({ page }) => {
  await hostSetContent(page, 'unchanged');
  await exec(page, 'no-such-command');
  expect(await getContent(page)).toBe('unchanged');
});

// ============================================================
// cursorContext — list-line transitions, deduped
// ============================================================

test('cursorContext posts onListLine transitions and dedups within a context', async ({ page }) => {
  await hostSetContent(page, 'plain line\n- list item');
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await clearMessages(page);

  // Move onto the list line -> one true.
  await page.keyboard.press('ArrowDown');
  await flushFrames(page);
  expect(await messagesOfType(page, 'cursorContext')).toEqual([
    { type: 'cursorContext', onListLine: true },
  ]);

  // Move within the same list line -> no re-post (deduped).
  await page.keyboard.press('ArrowRight');
  await flushFrames(page);
  expect(await messagesOfType(page, 'cursorContext')).toEqual([
    { type: 'cursorContext', onListLine: true },
  ]);

  // Move back onto the plain line -> one false.
  await page.keyboard.press('ArrowUp');
  await flushFrames(page);
  expect(await messagesOfType(page, 'cursorContext')).toEqual([
    { type: 'cursorContext', onListLine: true },
    { type: 'cursorContext', onListLine: false },
  ]);
});

// ============================================================
// Focus / blur and blurred live-preview
// ============================================================

test('focus() posts focus:true and blur() posts focus:false', async ({ page }) => {
  await clearMessages(page);
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await flushFrames(page);
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.blur());
  await flushFrames(page);

  expect(await messagesOfType(page, 'focus')).toEqual([
    { type: 'focus', focused: true },
    { type: 'focus', focused: false },
  ]);
});

test('a blurred editor hides all markdown markers; focusing reveals the cursor line', async ({
  page,
}) => {
  await hostSetContent(page, '**bold**');

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await flushFrames(page);
  expect(await page.locator('.cm-content').innerText()).toBe('**bold**');

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.blur());
  await flushFrames(page);
  expect(await page.locator('.cm-content').innerText()).toBe('bold');
});

// ============================================================
// Link routing — wikilinks (openNote) and external links (openUrl)
// ============================================================

async function tapCenter(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await flushFrames(page);
}

test('tapping a resolved wikilink posts openNote with the resolved id', async ({ page }) => {
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setNotes(
      JSON.stringify([{ id: 'Projects/Target', title: 'Target', modifiedMs: 1 }]),
    ),
  );
  await hostSetContent(page, 'see [[Target]] here');
  await clearMessages(page);

  await tapCenter(page, '.cm-md-wikilink:not(.cm-md-wikilink-broken)');
  expect(await messagesOfType(page, 'openNote')).toEqual([
    { type: 'openNote', id: 'Projects/Target' },
  ]);
});

test('tapping a broken wikilink posts nothing (recorded native Gap)', async ({ page }) => {
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setNotes(JSON.stringify([])),
  );
  await hostSetContent(page, 'see [[Nope]] here');
  await clearMessages(page);

  await tapCenter(page, '.cm-md-wikilink-broken');
  expect(await messages(page)).toEqual([]);
});

test('tapping an external link posts openUrl and never calls window.open', async ({ page }) => {
  await hostSetContent(page, 'visit https://example.com now');
  await clearMessages(page);

  await tapCenter(page, '.cm-md-link:not(.cm-md-wikilink)');
  expect(await messagesOfType(page, 'openUrl')).toEqual([
    { type: 'openUrl', url: 'https://example.com' },
  ]);
  expect(await page.evaluate(() => (window as unknown as FakeHostWindow).__openCalls)).toEqual([]);
});

// ============================================================
// Images — insert, base URL, and clipboard paste (both shapes)
// ============================================================

test('insertImage inserts the ![](filename) markdown', async ({ page }) => {
  await hostSetContent(page, 'start\n');
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.insertImage('name.png'),
  );
  await flushFrames(page);
  expect(await getContent(page)).toContain('![](name.png)');
});

test('setImageBaseUrl prefixes the rendered image src', async ({ page }) => {
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setImageBaseUrl('file:///vault/'),
  );
  await hostSetContent(page, '![](pic.png)');
  const src = await page.locator('.cm-md-image-widget').first().getAttribute('src');
  expect(src).toBe('file:///vault/pic.png');
});

test('pasting an image File posts saveImageData with base64 bytes and extension', async ({
  page,
}) => {
  await hostSetContent(page, 'doc');
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await clearMessages(page);

  await page.evaluate(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgo='), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'shot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document
      .querySelector('.cm-content')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
  });
  // The handler reads the File through an async FileReader — wait on the
  // message itself, never a fixed delay (M15).
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs.some((m) => m.type === 'saveImageData'),
  );

  expect(await messagesOfType(page, 'saveImageData')).toEqual([
    { type: 'saveImageData', data: 'iVBORw0KGgo=', ext: 'png' },
  ]);
});

test('pasting with a hidden bitmap (no File, no text/plain) posts pasteClipboardImage', async ({
  page,
}) => {
  await hostSetContent(page, 'doc');
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await clearMessages(page);

  const posted = await page.evaluate(() => {
    const dt = new DataTransfer();
    document
      .querySelector('.cm-content')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    // pasteClipboardImage posts synchronously inside the paste handler (no
    // FileReader involved), so the messages are already recorded here.
    return (window as unknown as FakeHostWindow).__msgs.filter(
      (m) => m.type === 'pasteClipboardImage',
    );
  });

  expect(posted).toEqual([{ type: 'pasteClipboardImage' }]);
});

// ============================================================
// Theming and native-toolbar suppression
// ============================================================

test('setTheme flips the documentElement theme attribute', async ({ page }) => {
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.setTheme('dark'));
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.setTheme('light'));
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
});

// ============================================================
// Legacy WebView (Chromium < 99) theme fallback — github#8
// ============================================================
//
// Non-updated Android 8-10 system WebViews predate @layer support and drop
// EVERY rule inside Tailwind's @layer blocks — including the theme variables
// and the body/.cm-editor text color. Both native hosts render the editor
// web view transparent over a native surface, so in dark mode the lost text
// color degrades to UA black-on-dark: invisible notes. These tests emulate
// that engine class exactly (an engine without @layer ignores those rules
// wholesale) by stripping every @layer statement/block from the bundle's CSS,
// and assert the unlayered fallback in editor.html keeps text legible in both
// themes. Reproduced for real on Chromium 98 (r950370) headless, 2026-07-23.

/**
 * Remove `@layer a, b;` statements and balanced `@layer ... { ... }` blocks.
 * Comments go first (a browser ignores them; the scanner must too — the
 * editor.html inline style talks ABOUT @layer in prose).
 */
function stripCssLayerRules(rawCss: string): string {
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let i = 0;
  for (;;) {
    const at = css.indexOf('@layer', i);
    if (at === -1) {
      out += css.slice(i);
      return out;
    }
    out += css.slice(i, at);
    let j = at + '@layer'.length;
    while (j < css.length && css[j] !== '{' && css[j] !== ';') j++;
    if (css[j] === ';') {
      i = j + 1;
      continue;
    }
    let depth = 0;
    do {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    } while (j < css.length && depth > 0);
    i = j;
  }
}

/** The bundle as a pre-@layer engine sees it: all layered CSS discarded. */
function writeLegacyWebViewBundle(): string {
  const html = readFileSync(EDITOR_BUNDLE_PATH, 'utf8');
  const stripped = html.replace(
    /<style([^>]*)>([\s\S]*?)<\/style>/g,
    (_m, attrs: string, css: string) => `<style${attrs}>${stripCssLayerRules(css)}</style>`,
  );
  const legacyPath = path.join(path.dirname(EDITOR_BUNDLE_PATH), 'editor-legacy-webview-test.html');
  writeFileSync(legacyPath, stripped);
  return `file://${legacyPath}`;
}

// Expected text colors come from the theme tokens so this spec can never
// drift from src/styles/theme.css.
function themeTextColor(theme: 'light' | 'dark'): string {
  const css = readFileSync(path.resolve('src/styles/theme.css'), 'utf8');
  const scope =
    theme === 'dark'
      ? css.slice(css.indexOf("[data-theme='dark']"))
      : css.slice(0, css.indexOf("[data-theme='dark']"));
  const hex = /--color-text:\s*#([0-9a-fA-F]{6})/.exec(scope)?.[1];
  if (!hex) throw new Error(`--color-text (${theme}) not found in src/styles/theme.css`);
  const [r, g, b] = [0, 2, 4].map((o) => parseInt(hex.slice(o, o + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

async function editorContentColor(
  browser: import('@playwright/test').Browser,
  url: string,
  theme: 'light' | 'dark',
): Promise<string> {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  await page.evaluate((t) => {
    const w = window as unknown as FakeHostWindow;
    w.FutoEditor.setTheme(t);
    w.FutoEditor.setContent('legible text probe');
  }, theme);
  await flushFrames(page);
  const color = await page.locator('.cm-content').evaluate((el) => getComputedStyle(el).color);
  await context.close();
  return color;
}

test('legacy WebView (no @layer): dark theme text keeps the dark token color', async ({
  browser,
}) => {
  const url = writeLegacyWebViewBundle();
  expect(await editorContentColor(browser, url, 'dark')).toBe(themeTextColor('dark'));
});

test('legacy WebView (no @layer): light theme text keeps the light token color', async ({
  browser,
}) => {
  const url = writeLegacyWebViewBundle();
  expect(await editorContentColor(browser, url, 'light')).toBe(themeTextColor('light'));
});

test('modern engine: the unlayered fallback does not fight the layered theme', async ({
  browser,
}) => {
  expect(await editorContentColor(browser, EDITOR_URL, 'dark')).toBe(themeTextColor('dark'));
  expect(await editorContentColor(browser, EDITOR_URL, 'light')).toBe(themeTextColor('light'));
});

// Regression guard for the Chromium 80–84 compatibility branch (github#8). The
// Playwright engine has a native String.prototype.replaceAll, so the editor.html
// shim is otherwise never exercised. Delete the native method before any page
// script runs (as a pre-85 WebView lacks it): Svelte 5's runtime calls it on
// mount, so the editor only reaches `ready` and renders if the classic-script
// shim restored it first. Remove the shim and this test times out at `ready`.
test('legacy WebView (no native replaceAll): the editor.html shim lets the bundle mount', async ({
  browser,
}) => {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(() => {
    delete (String.prototype as { replaceAll?: unknown }).replaceAll;
  });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(EDITOR_URL);
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('legacy shim probe'),
  );
  await flushFrames(page);
  await expect(page.locator('.cm-content')).toContainText('legacy shim probe');
  // The shim fills in only when the method is missing, so its presence now
  // proves the shim ran (not a native method that was never removed).
  expect(
    await page.evaluate(() => typeof (String.prototype as { replaceAll?: unknown }).replaceAll),
  ).toBe('function');
  await context.close();
});

test('setNativeToolbar(true) hides the embed web toolbar shown on focus', async ({ page }) => {
  await hostSetContent(page, 'doc');
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await flushFrames(page);
  // Default (no native toolbar): focusing the editor shows the web toolbar.
  await expect(page.locator('.markdown-toolbar')).toHaveCount(1);

  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setNativeToolbar(true),
  );
  await flushFrames(page);
  await expect(page.locator('.markdown-toolbar')).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.classList.contains('futo-native')),
  ).toBe(true);
});

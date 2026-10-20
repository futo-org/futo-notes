// The legacy-WebView CSS half of the Android System WebView floor. The floor itself
// and the built-in shim audit are described in editor-embed-webview-floor.spec.ts.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { EDITOR_BUNDLE_PATH, EDITOR_URL } from './editorEmbedBundle';
import { flushFrames, installFakeAndroidHost, type FakeHostWindow } from './lib/editorEmbedHost';

// ============================================================
// Legacy WebView CSS floor — github#8 (@layer) and github#33 (inset)
//
// Moved here verbatim when `editor-embed-bridge.spec.ts` was deleted at the
// engine swap. They were written against `.cm-content`/`.cm-scroller` because
// that was the editor at the time; the bug they lock is the BUNDLE's CSS
// floor, not any editor's, so they are retargeted at `.ProseMirror` — which
// under Milkdown is both the text surface and the scroll container.
// ============================================================

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
  browser: Browser,
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
    w.FutoEditor.setContent('test-note', 'legible text probe');
  }, theme);
  await flushFrames(page);
  const color = await page.locator('.ProseMirror').evaluate((el) => getComputedStyle(el).color);
  await context.close();
  return color;
}

// Non-updated Android 8-10 system WebViews predate @layer support and drop
// EVERY rule inside Tailwind's @layer blocks — including the theme variables
// and the editor's text color. Both native hosts render the editor web view
// transparent over a native surface, so in dark mode the lost text color
// degrades to UA black-on-dark: invisible notes. Reproduced for real on
// Chromium 98 (r950370) headless, 2026-07-23.
for (const theme of ['dark', 'light'] as const) {
  test(`legacy WebView (no @layer): ${theme} theme text keeps the ${theme} token color`, async ({
    browser,
  }) => {
    const url = writeLegacyWebViewBundle();
    expect(await editorContentColor(browser, url, theme)).toBe(themeTextColor(theme));
  });
}

test('modern engine: the unlayered fallback does not fight the layered theme', async ({
  browser,
}) => {
  expect(await editorContentColor(browser, EDITOR_URL, 'dark')).toBe(themeTextColor('dark'));
  expect(await editorContentColor(browser, EDITOR_URL, 'light')).toBe(themeTextColor('light'));
});

function engineVerdict(page: Page): Promise<string | null> {
  return page.evaluate(
    () => (window as unknown as { __futoEngineUnsupported: string | null }).__futoEngineUnsupported,
  );
}

test('engine preflight: a modern engine reports no missing capability', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(EDITOR_URL);
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  expect(await engineVerdict(page)).toBeNull();
  await context.close();
});

test('engine preflight: an engine below the ES2020 floor is reported unsupported', async ({
  browser,
}) => {
  const context = await browser.newContext();
  // Simulate a pre-ES2020 parser: the preflight decides by compiling the syntax
  // it needs through `new Function`, so make exactly that compilation throw the
  // SyntaxError an old engine would. `prototype` is carried over so `instanceof
  // Function` keeps working for everything else on the page. No host is
  // installed — the verdict is set by a classic <head> script, before any bundle.
  await context.addInitScript(() => {
    const real = window.Function;
    const stub = function (this: unknown, ...args: string[]) {
      if (/\?\.|\?\?/.test(args[args.length - 1] ?? '')) {
        throw new SyntaxError('simulated pre-ES2020 engine');
      }
      return (real as (...a: string[]) => unknown)(...args);
    };
    stub.prototype = real.prototype;
    Object.defineProperty(window, 'Function', { value: stub, configurable: true });
  });
  const page = await context.newPage();
  await page.goto(EDITOR_URL);
  expect(await engineVerdict(page)).toContain('ES2020 syntax');
  await context.close();
});

/**
 * The bundle as a Chromium 80-86 WebView sees it — the band that runs the whole
 * bundle but predates two things the layout leans on, so BOTH have to go for
 * this to be the real engine rather than a convenient half of it:
 *
 *  - `@layer` (Chromium 99): every layered rule is discarded, which takes
 *    src/styles/base.css's `body { position: fixed; inset: 0 }` with it.
 *  - the `inset` shorthand (Chromium 87): that one declaration is dropped and
 *    the rest of its rule kept, exactly as an unsupported declaration is.
 *
 * Only the shorthand: `inset-inline`/`inset-block` are separate properties and
 * are not what this emulates.
 */
function writePreInsetWebViewBundle(): string {
  const html = readFileSync(EDITOR_BUNDLE_PATH, 'utf8');
  const stripped = html.replace(
    /<style([^>]*)>([\s\S]*?)<\/style>/g,
    (_m, attrs: string, css: string) =>
      `<style${attrs}>${stripCssLayerRules(css).replace(/(^|[;{\s])inset\s*:[^;}]*;?/g, '$1')}</style>`,
  );
  const legacyPath = path.join(path.dirname(EDITOR_BUNDLE_PATH), 'editor-pre-inset-test.html');
  writeFileSync(legacyPath, stripped);
  return `file://${legacyPath}`;
}

interface EmbedGeometry {
  editorWidth: number;
  editorHeight: number;
  editorTop: number;
  innerWidth: number;
  innerHeight: number;
  scrollerOverflow: number;
  documentScrollTop: number;
}

async function embedGeometry(page: Page): Promise<EmbedGeometry> {
  return page.evaluate(() => {
    const editor = document.getElementById('editor') as HTMLElement;
    // `.ProseMirror` is the scroll container under Milkdown (it carries
    // `overflow-y: auto`), where CodeMirror had a separate `.cm-scroller`.
    const scroller = document.querySelector('.ProseMirror') as HTMLElement;
    const box = editor.getBoundingClientRect();
    return {
      editorWidth: Math.round(box.width),
      editorHeight: Math.round(box.height),
      editorTop: Math.round(box.top),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollerOverflow: scroller.scrollHeight - scroller.clientHeight,
      documentScrollTop: Math.round(document.scrollingElement?.scrollTop ?? 0),
    };
  });
}

async function openPreInsetEmbed(browser: Browser, markdown: string) {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 393, height: 700 },
  });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(writePreInsetWebViewBundle());
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  await page.evaluate(
    (md) => (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', md),
    markdown,
  );
  await flushFrames(page);
  return { context, page };
}

// github#33: on an Android System WebView older than Chromium 87 the editor
// pane filled itself with `inset: 0`, which that engine drops — so `#editor`
// shrink-wrapped its text instead of filling the web view, the editor's
// `height: 100%` resolved against an auto-height parent, and nothing became a
// scroll container. The note then grew past the bottom of the pane with
// nothing to scroll, and scroll-cursor-into-view moved the ROOT document
// instead, sliding the note up under the shell's native title bar. Reported on
// FUTO Notes 1.7.0 / Android 10.
test('pre-inset WebView: the editor pane still fills the web view', async ({ browser }) => {
  const { context, page } = await openPreInsetEmbed(browser, 'a short note');

  const geometry = await embedGeometry(page);
  expect(geometry.editorWidth).toBe(geometry.innerWidth);
  expect(geometry.editorHeight).toBe(geometry.innerHeight);
  await context.close();
});

// The consequence the user actually sees: with a definite height chain, the
// editor itself takes the overflow, so revealing the cursor never scrolls the
// root document out from under the native title.
test('pre-inset WebView: a long note scrolls inside the editor, not the document', async ({
  browser,
}) => {
  const { context, page } = await openPreInsetEmbed(
    browser,
    Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n\n'),
  );
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await flushFrames(page);

  const geometry = await embedGeometry(page);
  expect(geometry.scrollerOverflow).toBeGreaterThan(0);
  expect(geometry.documentScrollTop).toBe(0);
  expect(geometry.editorTop).toBe(0);
  await context.close();
});

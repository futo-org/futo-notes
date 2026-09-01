import { expect, test } from '@playwright/test';

import { CM6_EDITOR_URL, EDITOR_URL } from './editorEmbedBundle';
import { installFakeAndroidHost, type FakeHostWindow } from './lib/editorEmbedHost';

/**
 * The keyboard behaves the same in both editor engines — executable.
 *
 * This is a DRIFT LOCK (scripts/drift-registry.json `editor-ime-attributes`),
 * not a feature test. The same product decision is expressed twice while the
 * Milkdown transition is in flight, against two different editables:
 * `EditorView.contentAttributes` on `.cm-content`
 * (createMarkdownEditorRuntime.ts) and `editorViewOptionsCtx.attributes` on
 * `.ProseMirror` (MilkdownEditor.svelte). Neither can consume the other, so
 * only a test keeps them together.
 *
 * The decision: iOS autocorrect and sentence capitalisation ON, red spellcheck
 * squiggles and Apple's inline writing suggestions OFF. The Milkdown hook first
 * shipped with `autocorrect: 'off'` riding along with the squiggle fix, which
 * silently took autocorrect and predictive text away from every note typed in
 * the native shells — the swap's most-noticed regression. A keyboard is not a
 * detail of the engine; it is the product.
 */
const IME_ATTRIBUTES = ['autocorrect', 'autocapitalize', 'spellcheck', 'writingsuggestions'];

const EXPECTED = {
  autocorrect: 'on',
  autocapitalize: 'sentences',
  spellcheck: 'false',
  writingsuggestions: 'false',
};

async function imeAttributes(
  browser: import('@playwright/test').Browser,
  url: string,
  selector: string,
): Promise<Record<string, string | null>> {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.initialize(
      JSON.stringify({
        bridgeVersion: 7,
        theme: 'light',
        content: 'the quick brown fox',
        nativeToolbar: true,
        contentPaddingInlinePx: 14,
      }),
    ),
  );
  await page.waitForSelector(selector);
  const attributes = await page.evaluate(
    ([sel, keys]) => {
      const el = document.querySelector(sel as string);
      const out: Record<string, string | null> = {};
      for (const key of keys as string[]) out[key] = el?.getAttribute(key) ?? null;
      return out;
    },
    [selector, IME_ATTRIBUTES] as const,
  );
  await context.close();
  return attributes;
}

/** Inside code the keyboard's help is corruption, so every code surface opts out. */
const CODE_EXPECTED = {
  autocorrect: 'off',
  autocapitalize: 'off',
  spellcheck: 'false',
  writingsuggestions: 'false',
};

test('both engines hand the keyboard the same instructions', async ({ browser }) => {
  const milkdown = await imeAttributes(browser, EDITOR_URL, '.ProseMirror');
  const codemirror = await imeAttributes(browser, CM6_EDITOR_URL, '.cm-content');

  // Autocorrect on is the half that regressed; asserted by name so a future
  // "turn the squiggles off" change cannot quietly take it out again.
  expect(milkdown.autocorrect).toBe('on');
  expect(codemirror.autocorrect).toBe('on');
  expect(milkdown).toEqual(EXPECTED);
  expect(codemirror).toEqual(EXPECTED);
});

/**
 * The code surfaces DECLARE the inverse set — and this test asserts the
 * declaration, not a suppression.
 *
 * Autocorrect belongs to prose: the first adversarial pass after turning it back
 * on caught the keyboard rewriting a fence's contents (`dont` -> `don't`,
 * `teh` -> `Teh` inside a code block). The attributes below are what the HTML
 * spec says should scope that away. WKWebView ignores them — measured on the
 * iOS 26 simulator, 2026-09-01: it reads the traits from the editing host, so
 * autocorrect still fires inside a fence — while Blink is expected to honour
 * them (unverified, no Android device at the time). So: green here means the
 * page asks correctly, NOT that iOS obeys. Suppressing it on iOS needs the
 * caret's context to reach the shell for a `reloadInputViews()`.
 *
 * WYSIWYG only: the CodeMirror engine edits markdown SOURCE, where a fence is
 * ordinary text with no element of its own to carry an attribute.
 */
test('code blocks and inline code declare the autocorrect opt-out', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(EDITOR_URL);
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.initialize(
      JSON.stringify({
        bridgeVersion: 7,
        theme: 'light',
        content: 'prose with `inline code` in it\n\n```js\nconst dont = 1;\n```\n',
        nativeToolbar: true,
        contentPaddingInlinePx: 14,
      }),
    ),
  );
  await page.waitForSelector('.ProseMirror pre code');

  const surfaces = await page.evaluate(
    (keys) => {
      const read = (selector: string) => {
        const el = document.querySelector(selector);
        const out: Record<string, string | null> = {};
        for (const key of keys as string[]) out[key] = el?.getAttribute(key) ?? null;
        return out;
      };
      return {
        root: read('.ProseMirror'),
        pre: read('.ProseMirror pre'),
        code: read('.ProseMirror pre code'),
        inline: read('.ProseMirror p code'),
      };
    },
    IME_ATTRIBUTES as unknown as string[],
  );

  // The prose around them is untouched — this is a scoping fix, not a retreat.
  expect(surfaces.root.autocorrect).toBe('on');
  expect(surfaces.pre).toEqual(CODE_EXPECTED);
  expect(surfaces.code).toEqual(CODE_EXPECTED);
  expect(surfaces.inline).toEqual(CODE_EXPECTED);

  await context.close();
});

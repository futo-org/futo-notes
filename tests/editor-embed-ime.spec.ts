import { expect, test, type Browser } from '@playwright/test';

import { BRIDGE_VERSION } from '@futo-notes/editor';

import { EDITOR_URL } from './editorEmbedBundle';
import { installFakeAndroidHost, type FakeHostWindow } from './lib/editorEmbedHost';

/**
 * What the editor tells the keyboard — executable.
 *
 * This began as a drift lock between two engines (the deleted
 * `editor-ime-attributes` registry entry) and is now a plain feature test: one
 * editable, `.ProseMirror`, configured through `editorViewOptionsCtx.attributes`
 * in MilkdownEditor.svelte.
 *
 * The decision it locks: iOS autocorrect and sentence capitalisation ON, red
 * spellcheck squiggles and Apple's inline writing suggestions OFF. The Milkdown
 * hook first shipped with `autocorrect: 'off'` riding along with the squiggle
 * fix, which silently took autocorrect and predictive text away from every note
 * typed in the native shells — the transition's most-noticed regression. A
 * keyboard is not a detail of the engine; it is the product.
 */
const IME_ATTRIBUTES = ['autocorrect', 'autocapitalize', 'spellcheck', 'writingsuggestions'];

const EXPECTED = {
  autocorrect: 'on',
  autocapitalize: 'sentences',
  spellcheck: 'false',
  writingsuggestions: 'false',
};

type Attributes = Record<string, string | null>;

/** Boot the embed on `content` and read the IME attributes off each named selector. */
async function imeAttributes<Name extends string>(
  browser: Browser,
  content: string,
  selectors: Record<Name, string>,
): Promise<Record<Name, Attributes>> {
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
      noteId: 'test-note',
      theme: 'light',
      content,
      nativeToolbar: true,
      contentPaddingInlinePx: 14,
    }),
  );
  for (const selector of Object.values<string>(selectors)) await page.waitForSelector(selector);
  const attributes = await page.evaluate(
    ([named, keys]) =>
      Object.fromEntries(
        Object.entries(named).map(([name, selector]) => {
          const el = document.querySelector(selector);
          return [
            name,
            Object.fromEntries(keys.map((key) => [key, el?.getAttribute(key) ?? null])),
          ];
        }),
      ),
    [selectors as Record<string, string>, IME_ATTRIBUTES] as const,
  );
  await context.close();
  return attributes as Record<Name, Attributes>;
}

/** Inside code the keyboard's help is corruption, so every code surface opts out. */
const CODE_EXPECTED = {
  autocorrect: 'off',
  autocapitalize: 'off',
  spellcheck: 'false',
  writingsuggestions: 'false',
};

test('the editor hands the keyboard the intended instructions', async ({ browser }) => {
  const { root: attributes } = await imeAttributes(browser, 'the quick brown fox', {
    root: '.ProseMirror',
  });

  // Autocorrect on is the half that regressed; asserted by name so a future
  // "turn the squiggles off" change cannot quietly take it out again.
  expect(attributes.autocorrect).toBe('on');
  expect(attributes).toEqual(EXPECTED);
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
 */
test('code blocks and inline code declare the autocorrect opt-out', async ({ browser }) => {
  const surfaces = await imeAttributes(
    browser,
    'prose with `inline code` in it\n\n```js\nconst dont = 1;\n```\n',
    {
      root: '.ProseMirror',
      pre: '.ProseMirror pre',
      code: '.ProseMirror pre code',
      inline: '.ProseMirror p code',
    },
  );

  // The prose around them is untouched — this is a scoping fix, not a retreat.
  expect(surfaces.root.autocorrect).toBe('on');
  expect(surfaces.pre).toEqual(CODE_EXPECTED);
  expect(surfaces.code).toEqual(CODE_EXPECTED);
  expect(surfaces.inline).toEqual(CODE_EXPECTED);
});

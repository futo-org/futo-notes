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

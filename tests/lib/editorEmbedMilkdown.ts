// The page fixture and host calls shared by the editor-embed-milkdown*.spec.ts
// bridge suites, moved here verbatim from editor-embed-milkdown.spec.ts.

import { test as base, type Page } from '@playwright/test';
import { BRIDGE_VERSION } from '@futo-notes/editor';
import { EDITOR_URL } from '../editorEmbedBundle';
import {
  flushFrames,
  installFakeAndroidHost,
  withCaretObserved,
  type FakeHostWindow,
} from './editorEmbedHost';

/** @milkdown/plugin-listener debounces `markdownUpdated` by 200 ms (trailing). */
export const CHANGE_DEBOUNCE_MS = 200;

/**
 * Bounded wait for "no message arrives". Asserting an ABSENCE needs a window,
 * and the only honest one is the debounce the editor actually runs on.
 */
export async function settleChangeDebounce(page: Page): Promise<void> {
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 80);
  await flushFrames(page);
}

/**
 * Records whether the progressive-open affordance ever appeared, for the whole
 * life of the page. Installed as an init script rather than armed per test:
 * how long a tail takes to stream is a property of the machine, so polling for
 * it would be asserting that this box is slow, and a test that has to remember
 * to arm its own watch is a test that will one day forget.
 */
function installStreamingTailWatch(): void {
  const w = window as unknown as { __tail: { seen: boolean; role: string | null } };
  w.__tail = { seen: false, role: null };
  new MutationObserver(() => {
    const el = document.querySelector('.milkdown-stream-tail');
    if (!el) return;
    w.__tail.seen = true;
    w.__tail.role = el.getAttribute('role');
    // `document`, not `document.documentElement`: an init script runs before
    // the latter exists, and a MutationObserver takes the Document itself.
  }).observe(document, { childList: true, subtree: true });
}

export function readTailWatch(page: Page): Promise<{ seen: boolean; role: string | null }> {
  return page.evaluate(
    () => (window as unknown as { __tail: { seen: boolean; role: string | null } }).__tail,
  );
}

export const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({ hasTouch: true });
    await context.addInitScript(installFakeAndroidHost);
    await context.addInitScript(installStreamingTailWatch);
    const page = await context.newPage();
    await page.goto(EDITOR_URL);
    await page.waitForFunction(() =>
      (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
    );
    await use(page);
    await context.close();
  },
});

export function hostConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    bridgeVersion: BRIDGE_VERSION,
    noteId: 'test-note',
    theme: 'light',
    content: '',
    nativeToolbar: true,
    contentPaddingInlinePx: 14,
    ...overrides,
  });
}

export async function initialize(page: Page, configJson: string): Promise<void> {
  await page.evaluate(
    (json) => (window as unknown as FakeHostWindow).FutoEditor.initialize(json),
    configJson,
  );
  await flushFrames(page);
}

export async function hostSetContent(page: Page, markdown: string): Promise<void> {
  await page.evaluate(
    (md) => (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', md),
    markdown,
  );
  await settleChangeDebounce(page);
}

/**
 * Puts the caret `chars` characters into the first paragraph, and returns once
 * the EDITOR has read it (`withCaretObserved`).
 *
 * The caret is set on the DOM selection, not clicked at a pixel measured from
 * a Range: where a click lands depends on the glyph advances at that instant,
 * and the embed's fonts are swapped in asynchronously (`warmEditorFonts.ts`),
 * which `document.fonts.ready` did not make the measurement safe from. The
 * callers are about what the host does to a caret that is somewhere in the
 * text, not about where a click maps. Observed as an intermittent red on
 * "applyExternalContent with unchanged content preserves the selection" (CI,
 * test:e2e:editor-embed 2/3): "abcdefZ" for "abcZdef", the caret still at the
 * end where `focus()` left it. Not reproducible locally in 300 loaded runs,
 * so a click that missed the text is the likely cause, not a proven one; the
 * product's identical-content path never touches the selection.
 */
export async function placeCaretInto(page: Page, chars: number): Promise<void> {
  await withCaretObserved(page, () =>
    page.evaluate((offset) => {
      const text = document.querySelector('.ProseMirror > p')?.firstChild;
      if (!text) throw new Error('no paragraph text node');
      window.getSelection()!.collapse(text, offset);
    }, chars),
  );
}

/**
 * Dispatches a `paste` on the ProseMirror surface. See the file header for why
 * a synthetic ClipboardEvent is the honest ceiling here.
 */
export async function pasteClipboard(
  page: Page,
  build: 'imageFile' | 'hiddenBitmap' | 'plainText' | Record<string, string>,
): Promise<void> {
  await page.evaluate((kind) => {
    const dt = new DataTransfer();
    if (typeof kind === 'object') {
      for (const [format, data] of Object.entries(kind)) dt.setData(format, data);
    } else if (kind === 'imageFile') {
      const bytes = Uint8Array.from(atob('iVBORw0KGgo='), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    } else if (kind === 'plainText') {
      dt.setData('text/plain', 'just words');
    }
    document
      .querySelector('.ProseMirror')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
  }, build);
}

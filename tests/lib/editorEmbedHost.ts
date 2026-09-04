/**
 * Shared fake-host harness for the editor-embed Playwright specs.
 *
 * Both engine suites (`editor-embed-bridge.spec.ts` for CodeMirror,
 * `editor-embed-milkdown.spec.ts` for Milkdown) drive the SAME single-file
 * `editor.html` the native shells ship, with a fake native host installed
 * before any page script runs. The host side of that contract is identical for
 * both engines, so it lives here rather than being copied per suite.
 */
import type { Browser, Page } from '@playwright/test';

export interface BridgeMessage {
  type: string;
  [key: string]: unknown;
}

export interface FakeHostWindow extends Window {
  __msgs: BridgeMessage[];
  __openCalls: unknown[][];
  FutoEditor: {
    initialize(configJson: string): void;
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

/**
 * Installed via `addInitScript` BEFORE the bundle's own scripts, so the very
 * first `ready` post lands in `__msgs`. Also stubs `window.open` so a test can
 * prove external links never fall back to it while a host is present.
 */
export function installFakeAndroidHost(): void {
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

/** Opens `url` with the fake host installed and waits for the `ready` post. */
export async function openEmbed(
  browser: Browser,
  url: string,
  options: { userAgent?: string } = {},
): Promise<{ context: import('@playwright/test').BrowserContext; page: Page }> {
  const context = await browser.newContext({ hasTouch: true, ...options });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  return { context, page };
}

/** Let a rAF-coalesced callback flush before asserting. */
export function flushFrames(page: Page): Promise<void> {
  return page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

export function messages(page: Page): Promise<BridgeMessage[]> {
  return page.evaluate(() => (window as unknown as FakeHostWindow).__msgs);
}

export async function messagesOfType(page: Page, type: string): Promise<BridgeMessage[]> {
  return (await messages(page)).filter((m) => m.type === type);
}

export async function clearMessages(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as FakeHostWindow).__msgs.length = 0;
  });
}

export function getContent(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.getContent());
}

export function focusEditor(page: Page): Promise<void> {
  return page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
}

interface CaretProbeWindow extends Window {
  __caretMoves?: number;
  __caretBaseline?: number;
}

/**
 * Runs `move` — a click or a tap that places the caret — and returns only once
 * the EDITOR has been told about it.
 *
 * A pointer-driven caret move does not reach ProseMirror synchronously. The
 * browser moves the DOM caret during the click, then reports it with a
 * `selectionchange` event delivered on the next rendering update — measured at
 * ~15 ms in headless Chromium — and ProseMirror's DOMObserver only reads
 * `view.state.selection` out of the DOM when that event fires. Playwright's
 * calls are ~2-4 ms apart, so `click(); keyboard.press(...)` hands the key to
 * an editor whose state still holds the PREVIOUS caret, and every command that
 * reads the selection acts at the wrong place. No human and no soft keyboard
 * types inside one animation frame of a tap; only a synthetic driver does.
 *
 * So the fix is to WAIT ON THE CONDITION rather than to slow the test down
 * (AGENTS.md M15): this counts the very `selectionchange` ProseMirror syncs
 * from. Its own listener is registered when the view is constructed, i.e.
 * before this one, so by the time the counter moves the editor has already
 * read the caret.
 *
 * `move` MUST actually change the selection, or there is nothing to wait for
 * and the wait times out. Use it for the click that places the caret, not for
 * a follow-up key that may be a no-op (`End` when the caret is already there).
 *
 * Until 2026-09-01 the `editor-embed-milkdown-interactive` table cases passed
 * without this, by luck: `@milkdown/plugin-block` wrote a `data-dragging`
 * attribute on the ProseMirror root on pointer activity, and that DOM mutation
 * tripped ProseMirror's MutationObserver into an early flush. Commit e45718be
 * gave both native shells the long-press block drag, which drops that plugin,
 * and the four Tab/Enter cases started failing on the latent race.
 */
export async function withCaretObserved(page: Page, move: () => Promise<void>): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as CaretProbeWindow;
    if (w.__caretMoves === undefined) {
      w.__caretMoves = 0;
      document.addEventListener('selectionchange', () => {
        (window as unknown as CaretProbeWindow).__caretMoves! += 1;
      });
    }
    w.__caretBaseline = w.__caretMoves;
  });
  await move();
  await page.waitForFunction(() => {
    const w = window as unknown as CaretProbeWindow;
    return (w.__caretMoves ?? 0) > (w.__caretBaseline ?? 0);
  });
}

/** Waits until at least `count` messages of `type` have arrived. */
export async function waitForMessages(
  page: Page,
  type: string,
  count = 1,
): Promise<BridgeMessage[]> {
  await page.waitForFunction(
    ({ type: t, count: n }) =>
      (window as unknown as FakeHostWindow).__msgs.filter((m) => m.type === t).length >= n,
    { type, count },
  );
  return messagesOfType(page, type);
}

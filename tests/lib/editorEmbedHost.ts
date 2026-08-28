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

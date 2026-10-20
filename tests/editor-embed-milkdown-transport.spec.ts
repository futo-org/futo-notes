// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect } from '@playwright/test';
import { BRIDGE_VERSION } from '@futo-notes/editor';
import { EDITOR_URL } from './editorEmbedBundle';
import {
  type BridgeMessage,
  clearMessages,
  flushFrames,
  getContent,
  messagesOfType,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import { test, hostConfig, initialize } from './lib/editorEmbedMilkdown';

// ============================================================
// Transport, host config and theming
//
// Engine-independent halves of the bridge contract, moved here verbatim when
// `editor-embed-bridge.spec.ts` (the CodeMirror engine's copy) was deleted at
// the swap. They assert `bridge.ts`'s wiring, not any editor's behaviour, and
// were the only place that asserted it.
// ============================================================

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
  expect(ios[0].version).toBe(BRIDGE_VERSION);
  expect(android).toHaveLength(0);

  await context.close();
});

test('a stale host still gets a working editor, plus a version-mismatch report', async ({
  page,
}) => {
  // Refusing to boot would turn a build-hygiene mistake into a permanently
  // blank editor — see BridgeVersionMismatchMessage in bridge.ts.
  await clearMessages(page);

  await initialize(page, hostConfig({ bridgeVersion: 6, content: 'still editable' }));

  expect(await getContent(page)).toBe('still editable');
  expect(await messagesOfType(page, 'bridgeVersionMismatch')).toEqual([
    { type: 'bridgeVersionMismatch', hostVersion: 6, bundleVersion: BRIDGE_VERSION },
  ]);
  expect(await messagesOfType(page, 'initialized')).toHaveLength(1);
});

test('initialize suppresses the web toolbar for a shell that renders its own', async ({ page }) => {
  await initialize(page, hostConfig({ nativeToolbar: true }));
  expect(
    await page.evaluate(() => document.documentElement.classList.contains('futo-native')),
  ).toBe(true);

  await initialize(page, hostConfig({ nativeToolbar: false }));
  expect(
    await page.evaluate(() => document.documentElement.classList.contains('futo-native')),
  ).toBe(false);
});

test('setNativeToolbar(true) hides the embed web toolbar shown on focus', async ({ page }) => {
  await initialize(page, hostConfig({ nativeToolbar: false, content: 'doc' }));
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

test('setTheme flips the documentElement theme attribute', async ({ page }) => {
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.setTheme('dark'));
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.setTheme('light'));
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
});

import { test, expect, Page } from '@playwright/test';

// Rendered-UI coverage for the sync status-bar indicator (docs/spec/sync.md):
// the ⚠ error indicator with click-to-dismiss, and the persistent idle ✓
// tick driven by the live-stream state. State-layer behavior is covered in
// src/lib/syncManager.test.ts; these prove the template wiring (indicator
// precedence, the dismiss button actually clearing) in a real browser.

interface ShellTestHook {
  handleSyncComplete: (summary: {
    uploaded: number;
    downloaded: number;
    deleted: number;
    conflicts: number;
    failures: Array<{ filename: string; kind: string; statusCode?: number }>;
    failureMessage: string | null;
    updatedIds: string[];
    deletedIds: string[];
    renamed: Array<{ fromId: string; toId: string }>;
    peerUpdatedIds: string[];
    peerDeletedIds: string[];
  }) => Promise<void>;
  handleLiveState: (payload: { live: boolean; status: string; message?: string }) => void;
}

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() =>
    Boolean((window as typeof window & { __notesShellTest?: unknown }).__notesShellTest),
  );
}

async function completeSync(page: Page, failureMessage: string | null): Promise<void> {
  await page.evaluate(async (message) => {
    const w = window as typeof window & { __notesShellTest: ShellTestHook };
    await w.__notesShellTest.handleSyncComplete({
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      failures: message ? [{ filename: 'note.md', kind: 'upload', statusCode: 500 }] : [],
      failureMessage: message,
      updatedIds: [],
      deletedIds: [],
      renamed: [],
      peerUpdatedIds: [],
      peerDeletedIds: [],
    });
  }, failureMessage);
}

function liveState(
  page: Page,
  payload: { live: boolean; status: string; message?: string },
): Promise<void> {
  return page.evaluate((p) => {
    const w = window as typeof window & { __notesShellTest: ShellTestHook };
    w.__notesShellTest.handleLiveState(p);
  }, payload);
}

test.describe('Sync status bar', () => {
  test('failing cycle shows the ⚠ indicator; clicking it dismisses', async ({ page }) => {
    await openApp(page);
    await completeSync(page, "1 change couldn't reach the server (HTTP 500)");

    const errorButton = page.locator('.sync-indicator.sync-error');
    await expect(errorButton).toBeVisible();
    await expect(errorButton).toHaveAttribute(
      'title',
      "1 change couldn't reach the server (HTTP 500) — click to dismiss",
    );

    await errorButton.click();
    await expect(errorButton).toHaveCount(0);
  });

  test('a clean cycle clears the error indicator', async ({ page }) => {
    await openApp(page);
    await completeSync(page, "1 change couldn't reach the server (HTTP 500)");
    await expect(page.locator('.sync-indicator.sync-error')).toBeVisible();

    await completeSync(page, null);
    await expect(page.locator('.sync-indicator.sync-error')).toHaveCount(0);
  });

  test('idle ✓ tick renders while live and yields to the error indicator', async ({ page }) => {
    await openApp(page);

    await liveState(page, { live: true, status: 'connected' });
    await expect(page.locator('.sync-indicator.sync-idle')).toBeVisible();

    // Error outranks the tick…
    await completeSync(page, "1 change couldn't reach the server (HTTP 500)");
    await expect(page.locator('.sync-indicator.sync-error')).toBeVisible();
    await expect(page.locator('.sync-indicator.sync-idle')).toHaveCount(0);

    // …and a clean cycle restores it (live never dropped).
    await completeSync(page, null);
    await expect(page.locator('.sync-indicator.sync-idle')).toBeVisible();
  });

  test('a live cycle-error keeps the tick state (live) while raising the error', async ({
    page,
  }) => {
    await openApp(page);
    await liveState(page, { live: true, status: 'connected' });
    await liveState(page, { live: true, status: 'cycle-error', message: 'HTTP 500' });

    // Error shows now; dismissing must reveal the still-live tick — proving
    // the cycle error did not tear down the connected state.
    const errorButton = page.locator('.sync-indicator.sync-error');
    await expect(errorButton).toBeVisible();
    await errorButton.click();
    await expect(page.locator('.sync-indicator.sync-idle')).toBeVisible();
  });

  test('a stream error drops the tick until reconnect', async ({ page }) => {
    await openApp(page);
    await liveState(page, { live: true, status: 'connected' });
    await liveState(page, { live: false, status: 'reconnecting', message: 'stream lost' });

    await expect(page.locator('.sync-indicator.sync-error')).toBeVisible();
    await expect(page.locator('.sync-indicator.sync-idle')).toHaveCount(0);

    // Reconnect clears the stream error and restores the tick.
    await liveState(page, { live: true, status: 'connected' });
    await expect(page.locator('.sync-indicator.sync-error')).toHaveCount(0);
    await expect(page.locator('.sync-indicator.sync-idle')).toBeVisible();
  });
});

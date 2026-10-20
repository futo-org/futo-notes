// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  autoSyncCallbacks,
  emptySummary,
  makeManager,
  resetSyncManagerHarness,
} from './__test__/syncManagerHarness';
import { currentWriteRefusal } from './hostedWriteRefusal.svelte';
import type { SyncSummary } from './syncServiceE2ee';

beforeEach(resetSyncManagerHarness);

afterEach(() => {
  vi.useRealTimers();
});

describe('sync outcome state', () => {
  it('keeps a background transport error quiet and clears it on the next clean cycle', async () => {
    const { manager } = makeManager();
    const cleanup = manager.start();
    autoSyncCallbacks!.onSyncError(new TypeError('Load failed'), 'poll');
    expect(manager.syncError).toBe(false);
    expect(manager.reconnecting).toBe(true);

    await autoSyncCallbacks!.onSyncComplete(emptySummary, 'poll');
    expect(manager.syncError).toBe(false);
    expect(manager.reconnecting).toBe(false);
    cleanup();
  });

  it('toasts once per distinct failure message and re-arms after a clean cycle', async () => {
    const { manager, toasts } = makeManager();
    const failure = (code: number): SyncSummary => ({
      ...emptySummary,
      failures: [{ filename: 'note.md', kind: 'upload', statusCode: code }],
      failureMessage: `1 change couldn't reach the server (HTTP ${code})`,
    });

    await manager.handleSyncComplete(failure(500), 'poll');
    await manager.handleSyncComplete(failure(500), 'poll');
    await manager.handleSyncComplete(failure(403), 'poll');
    await manager.handleSyncComplete(emptySummary, 'poll');
    await manager.handleSyncComplete(failure(500), 'poll');

    expect(toasts).toEqual([
      { path: 'sync.errors.completedWithErrors' },
      { path: 'sync.errors.completedWithErrors' },
      { path: 'sync.errors.completedWithErrors' },
    ]);
  });

  /**
   * A refused write is not a fault, and "Sync completed with errors" sent
   * people looking for a server problem that was not there. Rust names the
   * refusal (`futo_notes_sync::WriteRefusal`); the status line says so
   * wherever the person happens to be, without Settings being open
   * (ADR 0003 decision 8).
   */
  describe('a refused write', () => {
    const refused = (writeRefusal: SyncSummary['writeRefusal'], code: number): SyncSummary => ({
      ...emptySummary,
      failures: [{ filename: 'note.md', kind: 'upload', statusCode: code }],
      failureMessage: `1 change couldn't reach the server (HTTP ${code})`,
      writeRefusal,
    });

    it('says the subscription lapsed rather than that sync broke', async () => {
      const { manager, toasts } = makeManager();
      await manager.handleSyncComplete(refused('subscriptionRequired', 402), 'poll');

      expect(manager.syncError).toBe(true);
      expect(manager.syncErrorMessage).toBe(
        'Sync paused. Your subscription has lapsed, so changes made here are not uploaded. Notes from your other devices still arrive.',
      );
      expect(toasts).toEqual([{ path: 'sync.errors.writePausedSubscription' }]);
    });

    it('says the vault is full rather than that sync broke', async () => {
      const { manager, toasts } = makeManager();
      await manager.handleSyncComplete(refused('quotaExceeded', 507), 'poll');

      expect(manager.syncErrorMessage).toBe(
        'Vault is full. You have used all of your storage, so changes made here are not uploaded.',
      );
      expect(toasts).toEqual([{ path: 'sync.errors.writePausedQuota' }]);
    });

    it('goes back to the ordinary wording once the cycle is an ordinary failure', async () => {
      const { manager } = makeManager();
      await manager.handleSyncComplete(refused('subscriptionRequired', 402), 'poll');
      await manager.handleSyncComplete(refused(null, 500), 'poll');

      expect(manager.syncErrorMessage).toBe(
        'Sync completed with errors. Some changes could not reach the server.',
      );
    });

    // The banner in Settings reads the same cycle, and reads it whether or
    // not anybody was looking when it ended.
    it('records the refusal for the banner, and the next clean cycle clears it', async () => {
      const { manager } = makeManager();
      await manager.handleSyncComplete(refused('quotaExceeded', 507), 'poll');
      expect(currentWriteRefusal()).toBe('quotaExceeded');

      await manager.handleSyncComplete(emptySummary, 'poll');
      expect(currentWriteRefusal()).toBeNull();
    });
  });
});

describe('sync transport grace period', () => {
  it('keeps an alternating post-wake transport outage quiet during the grace period', () => {
    const { manager, toasts } = makeManager();
    manager.start();
    vi.setSystemTime(new Date('2026-08-24T15:58:44Z'));

    for (let elapsed = 0; elapsed <= 120_000; elapsed += 15_000) {
      vi.setSystemTime(new Date(Date.parse('2026-08-24T15:58:44Z') + elapsed));
      manager.handleLiveState({
        live: false,
        status: 'reconnecting',
        message: 'connect: error sending request for url (https://notes.example.com/objects)',
      });
      autoSyncCallbacks!.onSyncError(new TypeError('Load failed'), 'poll');
    }

    expect(toasts).toEqual([]);
    expect(manager.syncError).toBe(false);
    expect(manager.reconnecting).toBe(true);
  });

  it('escalates a persistent transport outage exactly once after three minutes', () => {
    const { manager, toasts } = makeManager();
    manager.start();
    const startedAt = Date.parse('2026-08-24T15:58:44Z');

    for (let elapsed = 0; elapsed <= 195_000; elapsed += 15_000) {
      vi.setSystemTime(new Date(startedAt + elapsed));
      manager.handleLiveState({
        live: false,
        status: 'reconnecting',
        message: 'connect: error sending request for url (https://notes.example.com/objects)',
      });
      autoSyncCallbacks!.onSyncError(new TypeError('Load failed'), 'poll');
    }

    expect(toasts).toEqual([{ path: 'sync.errors.liveUnavailable' }]);
    expect(manager.syncError).toBe(true);
  });

  it('a clean cycle resets the quiet reconnecting clock', async () => {
    const { manager, toasts } = makeManager();
    manager.start();
    const startedAt = Date.parse('2026-08-24T15:58:44Z');
    vi.setSystemTime(new Date(startedAt));
    autoSyncCallbacks!.onSyncError(new TypeError('Load failed'), 'poll');
    vi.setSystemTime(new Date(startedAt + 120_000));
    autoSyncCallbacks!.onSyncError(new TypeError('Load failed'), 'poll');

    await manager.handleSyncComplete(emptySummary, 'poll');
    expect(manager.reconnecting).toBe(false);

    vi.setSystemTime(new Date(startedAt + 240_000));
    autoSyncCallbacks!.onSyncError(new TypeError('Load failed'), 'poll');
    vi.setSystemTime(new Date(startedAt + 300_000));
    autoSyncCallbacks!.onSyncError(new TypeError('Load failed'), 'poll');

    expect(toasts).toEqual([]);
    expect(manager.syncError).toBe(false);
    expect(manager.reconnecting).toBe(true);
  });
});

describe('sync error escalation policy', () => {
  it('surfaces every manual failure immediately', () => {
    const { manager, toasts } = makeManager();
    manager.start();

    autoSyncCallbacks!.onSyncError(new TypeError('Load failed'), 'manual');

    expect(manager.reconnecting).toBe(false);
    expect(manager.syncError).toBe(true);
    expect(toasts).toHaveLength(1);
  });

  it('surfaces live authentication failures immediately without exposing the diagnostic', () => {
    const { manager, toasts } = makeManager();

    manager.handleLiveState({
      live: false,
      status: 'reconnecting',
      message: 'auth: HTTP 401 Unauthorized',
    });

    expect(manager.reconnecting).toBe(false);
    expect(manager.syncErrorMessage).toBe(
      'Live sync is temporarily unavailable. FUTO Notes will keep retrying.',
    );
    expect(toasts).toEqual([{ path: 'sync.errors.liveUnavailable' }]);
  });

  // The connect form reports a certificate rejection through
  // createSyncSettings' failureMessage; the live loop and background cycles
  // reach this manager instead, and the same promise holds (sync.md).
  describe('a certificate rejection', () => {
    const rejection =
      'error sending request for url (https://notes.example.com/api/sync/events): ' +
      'client error (Connect): invalid peer certificate: UnknownIssuer';

    it('from the live stream reconnect is reported as such, immediately', () => {
      const { manager, toasts } = makeManager();

      manager.handleLiveState({
        live: false,
        status: 'reconnecting',
        message: `connect: ${rejection}`,
      });

      expect(manager.reconnecting).toBe(false);
      expect(manager.syncErrorMessage).toContain("This server's certificate isn't trusted");
      expect(toasts).toEqual([{ path: 'sync.errors.certificateNotTrusted' }]);
    });

    it('from a live cycle is reported as such', () => {
      const { manager, toasts } = makeManager();

      manager.handleLiveState({ live: true, status: 'cycle-error', message: rejection });

      expect(toasts).toEqual([{ path: 'sync.errors.certificateNotTrusted' }]);
    });

    it('from a background poll is reported as such', () => {
      const { manager, toasts } = makeManager();
      manager.start();

      autoSyncCallbacks!.onSyncError(new Error(rejection), 'poll');

      expect(manager.reconnecting).toBe(false);
      expect(toasts).toEqual([{ path: 'sync.errors.certificateNotTrusted' }]);
    });
  });

  it('surfaces completed-cycle per-item failures immediately', async () => {
    const { manager, toasts } = makeManager();

    await manager.handleSyncComplete(
      {
        ...emptySummary,
        failures: [{ filename: 'note.md', kind: 'upload', statusCode: 500 }],
        failureMessage: "1 change couldn't reach the server (HTTP 500)",
      },
      'poll',
    );

    expect(manager.reconnecting).toBe(false);
    expect(manager.syncError).toBe(true);
    expect(toasts).toEqual([{ path: 'sync.errors.completedWithErrors' }]);
  });

  it('names the files rejected as too large or unsupported', async () => {
    const { manager, toasts } = makeManager();
    await manager.handleSyncComplete(
      {
        ...emptySummary,
        failures: [{ filename: 'photos/large.png', kind: 'upload', statusCode: 413 }],
        failureMessage: "1 change couldn't reach the server (HTTP 413)",
      },
      'poll',
    );
    expect(manager.syncErrorMessage).toContain('photos/large.png');
    expect(toasts.at(-1)).toEqual({
      path: 'sync.errors.uploadsTooLarge',
      arguments: { filenames: 'photos/large.png' },
    });

    await manager.handleSyncComplete(
      {
        ...emptySummary,
        failures: [{ filename: 'a/b/c.md', kind: 'rejected', statusCode: null }],
        failureMessage: '1 note had an unsupported name and was skipped',
      },
      'poll',
    );
    expect(manager.syncErrorMessage).toContain('a/b/c.md');
    expect(toasts.at(-1)).toEqual({
      path: 'sync.errors.unsupportedPaths',
      arguments: { filenames: 'a/b/c.md' },
    });

    await manager.handleSyncComplete(
      {
        ...emptySummary,
        failures: [
          { filename: 'large.png', kind: 'upload', statusCode: 413 },
          { filename: 'deep/note.md', kind: 'rejected', statusCode: null },
        ],
        failureMessage: 'two failures',
      },
      'poll',
    );
    expect(manager.syncErrorMessage).toContain('large.png');
    expect(manager.syncErrorMessage).toContain('deep/note.md');
  });

  it('toasts again when a different file hits the same HTTP 413', async () => {
    const { manager, toasts } = makeManager();
    const rejected = (filename: string): SyncSummary => ({
      ...emptySummary,
      failures: [{ filename, kind: 'upload', statusCode: 413 }],
      failureMessage: "1 change couldn't reach the server (HTTP 413)",
    });
    await manager.handleSyncComplete(rejected('first.png'), 'poll');
    await manager.handleSyncComplete(rejected('second.png'), 'poll');
    expect(toasts).toEqual([
      { path: 'sync.errors.uploadsTooLarge', arguments: { filenames: 'first.png' } },
      { path: 'sync.errors.uploadsTooLarge', arguments: { filenames: 'second.png' } },
    ]);
  });

  it('normalizes stream and cycle transport wording before toast dedupe', () => {
    const { manager, toasts } = makeManager();
    manager.start();
    const startedAt = Date.parse('2026-08-24T15:58:44Z');
    vi.setSystemTime(new Date(startedAt));
    manager.handleLiveState({
      live: false,
      status: 'reconnecting',
      message: 'connect: error sending request for url (https://notes.example.com/objects)',
    });
    autoSyncCallbacks!.onSyncError(new TypeError('Load failed'), 'poll');

    vi.setSystemTime(new Date(startedAt + 180_000));
    manager.handleLiveState({
      live: false,
      status: 'reconnecting',
      message: 'connect: error sending request for url (https://notes.example.com/objects)',
    });
    autoSyncCallbacks!.onSyncError(new TypeError('Load failed'), 'poll');

    expect(toasts).toEqual([{ path: 'sync.errors.liveUnavailable' }]);
  });

  it('re-raises an escalated transient failure after click-to-dismiss', () => {
    const { manager, toasts } = makeManager();
    const startedAt = Date.parse('2026-08-24T15:58:44Z');
    const failure = {
      live: false,
      status: 'reconnecting',
      message: 'connect: error sending request for url (https://notes.example.com/objects)',
    };
    vi.setSystemTime(new Date(startedAt));
    manager.handleLiveState(failure);
    vi.setSystemTime(new Date(startedAt + 180_000));
    manager.handleLiveState(failure);

    manager.clearSyncError();
    manager.handleLiveState(failure);

    expect(toasts).toHaveLength(2);
    expect(manager.syncError).toBe(true);
    expect(manager.reconnecting).toBe(false);
  });

  it('a clean poll cannot clear a quiet reconnecting stream', async () => {
    const { manager } = makeManager();
    manager.handleLiveState({
      live: false,
      status: 'reconnecting',
      message: 'connect: error sending request for url (https://notes.example.com/objects)',
    });

    await manager.handleSyncComplete(emptySummary, 'poll');
    expect(manager.reconnecting).toBe(true);

    manager.handleLiveState({ live: true, status: 'connected' });
    expect(manager.reconnecting).toBe(false);
  });
});

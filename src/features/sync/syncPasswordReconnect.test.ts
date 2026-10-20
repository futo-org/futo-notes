// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  flush,
  fresh,
  kr,
  reboot,
  resetPasswordHarness,
  seedAppState,
  toastMock,
} from './__test__/syncPasswordHarness';

beforeEach(resetPasswordHarness);

describe('K3 — keyring deletion failure surfaces + retries', () => {
  it('disconnect delete failure toasts and persists a retry marker', async () => {
    const { platform, svc } = await fresh();
    await svc.connectE2ee('http://server', 'secret');
    expect(kr.store.get('pw')).toBe('secret');

    kr.fail.delete = true;
    await svc.disconnectE2ee();

    expect(toastMock.messages.length).toBe(1);
    expect(toastMock.messages[0]).toEqual({ path: 'sync.errors.forgetPasswordFailed' });
    const raw = await platform.testFS.readAppData('.app-state.json');
    expect(JSON.parse(raw!).pendingKeyringDeletion).toBe(true);
    expect(svc.hasStoredSyncPassword()).toBe(false); // in-memory cleared regardless
  });

  it('the next boot retries the outstanding deletion and clears the marker on success', async () => {
    const { svc } = await fresh();
    await svc.connectE2ee('http://server', 'secret');
    kr.fail.delete = true;
    await svc.disconnectE2ee();
    expect(kr.store.get('pw')).toBe('secret'); // orphaned in the keyring

    // Relaunch with a working keyring.
    kr.fail.delete = false;
    const b = await reboot();
    await b.svc.initSyncPassword();

    expect(kr.store.has('pw')).toBe(false); // orphan removed
    const raw = await b.platform.testFS.readAppData('.app-state.json');
    expect(JSON.parse(raw!).pendingKeyringDeletion).toBeUndefined();
  });

  it('a still-failing retry keeps the marker for another attempt', async () => {
    const { svc } = await fresh();
    await svc.connectE2ee('http://server', 'secret');
    kr.fail.delete = true;
    await svc.disconnectE2ee();

    const b = await reboot();
    await b.svc.initSyncPassword(); // keyring still failing

    const raw = await b.platform.testFS.readAppData('.app-state.json');
    expect(JSON.parse(raw!).pendingKeyringDeletion).toBe(true);
  });
});

describe('K5 — named coverage gaps', () => {
  it('(a) disconnect deletes the keyring entry (M4 path)', async () => {
    const { svc } = await fresh();
    await svc.connectE2ee('http://server', 'secret');
    expect(kr.store.get('pw')).toBe('secret');

    await svc.disconnectE2ee();

    expect(kr.store.has('pw')).toBe(false);
    expect(svc.hasStoredSyncPassword()).toBe(false);
  });

  it('(a) forget deletes the keyring entry', async () => {
    const { svc } = await fresh();
    await svc.connectE2ee('http://server', 'secret');
    await svc.forgetStoredSyncPassword();
    expect(kr.store.has('pw')).toBe(false);
    expect(svc.hasStoredSyncPassword()).toBe(false);
  });

  it('(b) connect with a failing keyring set still works this session and writes no plaintext', async () => {
    const { platform, svc } = await fresh();
    kr.fail.set = true;

    await expect(svc.connectE2ee('http://server', 'sess-only')).resolves.toBeUndefined();

    expect(svc.hasStoredSyncPassword()).toBe(true); // usable in-memory this session
    expect(svc.isE2eeConfigured()).toBe(true);
    expect(kr.store.has('pw')).toBe(false); // nothing persisted to the keyring
    const raw = await platform.testFS.readAppData('.app-state.json');
    expect(raw).not.toContain('sess-only'); // and never to disk plaintext
  });

  it('(c) initSyncPassword is idempotent when called twice', async () => {
    const { platform, svc } = await fresh();
    await platform.testFS.writeAppData(
      '.app-state.json',
      seedAppState({ e2eePassword: 'hunter2' }),
    );

    await svc.initSyncPassword();
    await svc.initSyncPassword();

    expect(kr.store.get('pw')).toBe('hunter2');
    expect(svc.hasStoredSyncPassword()).toBe(true);
    const raw = await platform.testFS.readAppData('.app-state.json');
    expect(JSON.parse(raw!).e2eePassword).toBeUndefined();
  });
});

describe('R1 — app-state file writes complete in call order', () => {
  it('a post-confirm scrub is never overwritten by an in-flight earlier save', async () => {
    const { platform, appState } = await fresh();
    const seed = seedAppState({ e2eePassword: 'PW' });

    // Custom FS whose writes only complete when the test releases them.
    let persisted = seed;
    const writes: Array<{ content: string; resolve: () => void }> = [];
    const gatedFS = {
      ...platform.testFS,
      async readAppData() {
        return persisted;
      },
      writeAppData(_rel: string, content: string) {
        return new Promise<void>((res) => {
          writes.push({
            content,
            resolve: () => {
              persisted = content;
              res();
            },
          });
        });
      },
    };
    platform.setActiveFS(gatedFS);

    try {
      await appState.loadAppState(); // captures the 'PW' holdover
      const state = appState.getAppState();

      // Save #1 captures the still-set holdover → payload carries 'PW'.
      const p1 = appState.saveAppState(state);
      await flush();
      // Migration confirms the keyring write, then scrubs.
      appState.clearLegacyE2eePassword();
      const p2 = appState.saveAppState(state);
      await flush();

      // Serialized: only the first write is in flight; the scrub is queued.
      expect(writes.length).toBe(1);
      expect(writes[0].content).toContain('PW');

      // Finish the older (plaintext) write FIRST — it must not win.
      writes[0].resolve();
      await flush();
      expect(writes.length).toBe(2);
      writes[1].resolve();
      await Promise.all([p1, p2]);

      // The scrub is the final on-disk state.
      expect(persisted).not.toContain('PW');
      expect(JSON.parse(persisted).e2eePassword).toBeUndefined();
    } finally {
      platform.resetActiveFS();
    }
  });
});

describe('R2 — pending deletion must not load a forgotten credential', () => {
  it('a still-failing delete retry leaves the password unloaded (no sync resume)', async () => {
    const { svc } = await fresh();
    await svc.connectE2ee('http://server', 'secret');

    kr.fail.delete = true;
    await svc.forgetStoredSyncPassword(); // delete fails → marker set, keyring keeps 'secret'
    expect(kr.store.get('pw')).toBe('secret'); // orphan still present

    // Relaunch; the keyring delete still fails.
    const b = await reboot();
    await b.svc.initSyncPassword();

    // The forgotten credential must NOT be loaded back into memory.
    expect(b.svc.hasStoredSyncPassword()).toBe(false);
    expect(b.svc.isE2eeConfigured()).toBe(false);
  });
});

describe('R3 — reconnect clears the deletion marker only after the keyring write', () => {
  it('a failing set keeps the marker; a succeeding set clears it', async () => {
    const { platform, svc } = await fresh();
    await svc.connectE2ee('http://server', 'OLD');
    kr.fail.delete = true;
    await svc.forgetStoredSyncPassword(); // marker set, 'OLD' orphaned in keyring
    kr.fail.delete = false;

    // Reconnect but the keyring set fails → marker must survive for the retry.
    kr.fail.set = true;
    await svc.connectE2ee('http://server', 'NEW');
    let raw = await platform.testFS.readAppData('.app-state.json');
    expect(JSON.parse(raw!).pendingKeyringDeletion).toBe(true);

    // Reconnect with a working keyring → new password persisted, marker cleared.
    kr.fail.set = false;
    await svc.connectE2ee('http://server', 'NEW');
    raw = await platform.testFS.readAppData('.app-state.json');
    expect(JSON.parse(raw!).pendingKeyringDeletion).toBeUndefined();
    expect(kr.store.get('pw')).toBe('NEW');
  });
});

describe('P2 — reconnect persists metadata before the keyring password', () => {
  it('a metadata-write failure never leaves a keyring password without matching metadata', async () => {
    const { platform, svc } = await fresh();
    // FS that rejects every .app-state.json write.
    const failingFS = {
      ...platform.testFS,
      async writeAppData() {
        throw new Error('disk full');
      },
    };
    platform.setActiveFS(failingFS);
    try {
      await expect(svc.connectE2ee('http://server', 'NEW')).rejects.toThrow(/disk full/);
      // The keyring set must NOT have run, since the metadata never landed —
      // otherwise a restart would resume the OLD vault with the NEW password.
      expect(kr.store.has('pw')).toBe(false);
    } finally {
      platform.resetActiveFS();
    }
  });

  it('a stale marker after a failed marker-clear costs a re-entry, never a mismatch', async () => {
    const { platform, svc } = await fresh();
    // Degenerate post-failure state: NEW metadata persisted, keyring holds NEW,
    // but the marker-clearing save never landed so the marker is still set.
    await platform.testFS.writeAppData(
      '.app-state.json',
      seedAppState({ pendingKeyringDeletion: true }),
    );
    kr.store.set('pw', 'NEW');

    await svc.initSyncPassword();

    // Boot retry removes the entry and loads nothing → the user re-enters the
    // password; no mismatched credential ever resumes.
    expect(kr.store.has('pw')).toBe(false);
    expect(svc.hasStoredSyncPassword()).toBe(false);
    expect(svc.isE2eeConfigured()).toBe(false);
  });
});

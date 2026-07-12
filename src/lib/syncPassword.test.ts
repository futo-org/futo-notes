// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real testFS-backed platform mock, but pretend we're on desktop (Tauri) so
// the password store talks to the (mocked) keyring commands.
vi.mock('$lib/platform', async () => {
  const mod = await vi.importActual<typeof import('$lib/platform/__mocks__/index')>(
    '$lib/platform/__mocks__/index',
  );
  return { ...mod, isTauri: true };
});

// Capture toasts (K3 surfaces delete failures through showGlobalToast).
const toastMock = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock('./toast', () => ({
  showGlobalToast: (m: string) => toastMock.messages.push(m),
  onToast: () => () => {},
}));

// Configurable in-memory stand-in for the OS keyring exposed by the Rust
// e2ee_password_* commands. `gate` lets a test hold an op mid-flight;
// `fail` forces a rejection to model an unavailable / erroring secret store.
const kr = vi.hoisted(() => ({
  store: new Map<string, string>(),
  gate: { set: null, get: null, delete: null } as Record<string, Promise<void> | null>,
  fail: { set: false, get: false, delete: false } as Record<string, boolean>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case 'e2ee_password_set':
        if (kr.gate.set) await kr.gate.set;
        if (kr.fail.set) throw new Error('keyring set failed');
        kr.store.set('pw', args!.password as string);
        return undefined;
      case 'e2ee_password_get':
        if (kr.gate.get) await kr.gate.get;
        if (kr.fail.get) throw new Error('keyring get failed');
        return kr.store.get('pw') ?? null;
      case 'e2ee_password_delete':
        if (kr.gate.delete) await kr.gate.delete;
        if (kr.fail.delete) throw new Error('keyring delete failed');
        kr.store.delete('pw');
        return undefined;
      case 'e2ee_connect':
        return { userId: 'u', collectionId: 'c', token: 't', authMode: 'password' };
      case 'e2ee_status':
        return { connected: false, maxVersion: 0, objectCount: 0 };
      // e2ee_disconnect / e2ee_stop_live / e2ee_resume / … → no-op
      default:
        return undefined;
    }
  }),
}));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let all currently-queued microtasks + a macrotask tick drain. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Fresh modules AND a wiped vault + keyring — a clean install. */
async function fresh() {
  vi.resetModules();
  const platform = await import('$lib/platform');
  platform.testFS._reset();
  kr.store.clear();
  const appState = await import('./appState');
  const svc = await import('./syncServiceE2ee');
  return { platform, appState, svc };
}

/** Fresh modules but keep the on-disk vault + keyring — a relaunch. */
async function reboot() {
  vi.resetModules();
  const platform = await import('$lib/platform');
  const appState = await import('./appState');
  const svc = await import('./syncServiceE2ee');
  return { platform, appState, svc };
}

function seedAppState(extra: Record<string, unknown>): string {
  return JSON.stringify({
    deviceId: 'device-1',
    e2eeServerUrl: 'http://server',
    e2eeAuthToken: 'token',
    e2eeUserId: 'user',
    e2eeCollectionId: 'collection',
    ...extra,
  });
}

const PREFS = {
  appearance: { theme: 'dark' as const },
  crashReporting: { enabled: true, alwaysSend: false },
  updates: { enabled: true },
  sync: { serverUrl: '', token: '', lastSyncedAt: null, lastError: '' },
};

beforeEach(async () => {
  const platform = await import('$lib/platform');
  platform.resetActiveFS(); // undo any custom FS a prior test installed
  kr.store.clear();
  kr.gate.set = kr.gate.get = kr.gate.delete = null;
  kr.fail.set = kr.fail.get = kr.fail.delete = false;
  toastMock.messages = [];
});

describe('E2EE vault password migration to the OS keyring (F6)', () => {
  it('moves a plaintext e2eePassword into the keyring and scrubs the JSON file', async () => {
    const { platform, svc } = await fresh();
    await platform.testFS.writeAppData(
      '.app-state.json',
      seedAppState({ e2eePassword: 'hunter2' }),
    );

    await svc.initSyncPassword();

    expect(kr.store.get('pw')).toBe('hunter2');
    const raw = await platform.testFS.readAppData('.app-state.json');
    expect(raw).not.toContain('hunter2');
    expect(JSON.parse(raw!).e2eePassword).toBeUndefined();
    expect(svc.hasStoredSyncPassword()).toBe(true);
    expect(svc.isE2eeConfigured()).toBe(true);
  });

  it('does NOT scrub the plaintext when the keyring write fails (retry next boot)', async () => {
    const { platform, svc } = await fresh();
    kr.fail.set = true;
    await platform.testFS.writeAppData(
      '.app-state.json',
      seedAppState({ e2eePassword: 'hunter2' }),
    );

    await expect(svc.initSyncPassword()).resolves.toBeUndefined();

    const raw = await platform.testFS.readAppData('.app-state.json');
    expect(JSON.parse(raw!).e2eePassword).toBe('hunter2');
    expect(kr.store.has('pw')).toBe(false);
    expect(svc.hasStoredSyncPassword()).toBe(false);
  });

  it('loads an existing keyring password on restart (no legacy field on disk)', async () => {
    const { platform, svc } = await fresh();
    kr.store.set('pw', 'from-keyring');
    await platform.testFS.writeAppData('.app-state.json', seedAppState({}));

    await svc.initSyncPassword();

    expect(svc.hasStoredSyncPassword()).toBe(true);
    expect(svc.isE2eeConfigured()).toBe(true);
  });

  it('never persists the password to .app-state.json on connect', async () => {
    const { platform, svc } = await fresh();
    await svc.connectE2ee('http://server', 'top-secret');

    const raw = await platform.testFS.readAppData('.app-state.json');
    expect(raw).not.toContain('top-secret');
    expect(JSON.parse(raw!).e2eePassword).toBeUndefined();
    expect(kr.store.get('pw')).toBe('top-secret');
    expect(svc.hasStoredSyncPassword()).toBe(true);
  });
});

describe('K1 — migration scrub race', () => {
  it('keeps the plaintext on disk across interleaved saves until the keyring write is confirmed', async () => {
    const { platform, appState, svc } = await fresh();
    await platform.testFS.writeAppData(
      '.app-state.json',
      seedAppState({ e2eePassword: 'hunter2' }),
    );

    // Migration in flight (keyring set gated open).
    const gate = deferred();
    kr.gate.set = gate.promise;
    const initP = svc.initSyncPassword();
    await flush();

    // A completely unrelated save interleaves the migration window.
    await appState.savePreferences(PREFS);

    // The holdover must have re-injected the plaintext — not scrubbed it.
    let raw = await platform.testFS.readAppData('.app-state.json');
    expect(JSON.parse(raw!).e2eePassword).toBe('hunter2');

    // The keyring write then FAILS.
    kr.fail.set = true;
    gate.resolve();
    await initP;

    // Password preserved on disk, absent from keyring → recoverable next boot.
    raw = await platform.testFS.readAppData('.app-state.json');
    expect(JSON.parse(raw!).e2eePassword).toBe('hunter2');
    expect(kr.store.has('pw')).toBe(false);

    // Next boot with a working keyring migrates + scrubs.
    kr.fail.set = false;
    const b = await reboot();
    await b.svc.initSyncPassword();
    raw = await b.platform.testFS.readAppData('.app-state.json');
    expect(JSON.parse(raw!).e2eePassword).toBeUndefined();
    expect(kr.store.get('pw')).toBe('hunter2');
    expect(b.svc.hasStoredSyncPassword()).toBe(true);
  });
});

describe('K2 — serialization + generation guard', () => {
  it('a disconnect that races an in-flight boot load is not resurrected', async () => {
    const { platform, svc } = await fresh();
    kr.store.set('pw', 'OLD');
    await platform.testFS.writeAppData('.app-state.json', seedAppState({}));

    const gate = deferred();
    kr.gate.get = gate.promise;
    const initP = svc.initSyncPassword(); // acquires lock, parks on gated get
    await flush();

    const disP = svc.disconnectE2ee(); // queues behind init
    await flush();

    gate.resolve();
    await Promise.all([initP, disP]);

    expect(svc.hasStoredSyncPassword()).toBe(false);
    expect(kr.store.has('pw')).toBe(false);
    expect(svc.isE2eeConfigured()).toBe(false);
    const raw = await platform.testFS.readAppData('.app-state.json');
    expect(JSON.parse(raw!).e2eeServerUrl).toBeUndefined();
  });

  it('a boot MIGRATION that lost the lock race to a newer connect neither overwrites it nor leaks plaintext', async () => {
    const { platform, svc } = await fresh();
    await platform.testFS.writeAppData(
      '.app-state.json',
      seedAppState({ e2eePassword: 'OLD-LEGACY' }),
    );

    // Disconnect grabs the lock first (bumps the generation), parked on delete.
    const delGate = deferred();
    kr.gate.delete = delGate.promise;
    const disP = svc.disconnectE2ee();
    await flush();

    // A fresh connect queues behind the disconnect and sets NEW.
    const conP = svc.connectE2ee('http://server', 'NEW');
    await flush();

    // The boot migration captures the (already-bumped) generation, queues last.
    const initP = svc.initSyncPassword();
    await flush();

    delGate.resolve();
    await Promise.all([disP, conP, initP]);

    // connect won; the stale migration must be abandoned AND the old plaintext
    // scrubbed (F6 holds regardless of who won the race).
    expect(kr.store.get('pw')).toBe('NEW');
    expect(svc.hasStoredSyncPassword()).toBe(true);
    const raw = await platform.testFS.readAppData('.app-state.json');
    expect(JSON.parse(raw!).e2eePassword).toBeUndefined();
  });
});

describe('K3 — keyring deletion failure surfaces + retries', () => {
  it('disconnect delete failure toasts and persists a retry marker', async () => {
    const { platform, svc } = await fresh();
    await svc.connectE2ee('http://server', 'secret');
    expect(kr.store.get('pw')).toBe('secret');

    kr.fail.delete = true;
    await svc.disconnectE2ee();

    expect(toastMock.messages.length).toBe(1);
    expect(toastMock.messages[0]).toMatch(/sync password/i);
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

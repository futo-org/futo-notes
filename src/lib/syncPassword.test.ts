// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real testFS-backed platform mock, but pretend we're on desktop (Tauri) so
// initSyncPassword() talks to the (mocked) keyring commands.
vi.mock('$lib/platform', async () => {
  const mod = await vi.importActual<typeof import('$lib/platform/__mocks__/index')>(
    '$lib/platform/__mocks__/index',
  );
  return { ...mod, isTauri: true };
});

// In-memory stand-in for the OS keyring exposed by the Rust e2ee_password_* commands.
const keyring = vi.hoisted(() => ({ value: new Map<string, string>(), failSet: false }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case 'e2ee_password_set':
        if (keyring.failSet) throw new Error('No Secret Service daemon available');
        keyring.value.set('pw', args!.password as string);
        return undefined;
      case 'e2ee_password_get':
        return keyring.value.get('pw') ?? null;
      case 'e2ee_password_delete':
        keyring.value.delete('pw');
        return undefined;
      case 'e2ee_status':
        return { connected: false, maxVersion: 0, objectCount: 0 };
      default:
        throw new Error(`unexpected invoke in test: ${cmd}`);
    }
  }),
}));

async function fresh() {
  vi.resetModules();
  const platform = await import('$lib/platform');
  platform.testFS._reset();
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

beforeEach(() => {
  keyring.value.clear();
  keyring.failSet = false;
});

describe('E2EE vault password migration to the OS keyring (F6)', () => {
  it('moves a plaintext e2eePassword into the keyring and scrubs the JSON file', async () => {
    const { platform, svc } = await fresh();
    await platform.testFS.writeAppData(
      '.app-state.json',
      seedAppState({ e2eePassword: 'hunter2' }),
    );

    await svc.initSyncPassword();

    // Password now lives in the keyring, not on disk.
    expect(keyring.value.get('pw')).toBe('hunter2');
    const raw = await platform.testFS.readAppData('.app-state.json');
    expect(raw).not.toContain('hunter2');
    expect(JSON.parse(raw!).e2eePassword).toBeUndefined();

    // Sync still knows it is configured and has a password (held in memory).
    expect(svc.hasStoredSyncPassword()).toBe(true);
    expect(svc.isE2eeConfigured()).toBe(true);
  });

  it('does NOT scrub the plaintext when the keyring write fails (retry next boot)', async () => {
    const { platform, svc } = await fresh();
    keyring.failSet = true;
    await platform.testFS.writeAppData(
      '.app-state.json',
      seedAppState({ e2eePassword: 'hunter2' }),
    );

    await expect(svc.initSyncPassword()).resolves.toBeUndefined();

    // Keyring unavailable: never fall back to disk, but do not lose the value.
    const raw = await platform.testFS.readAppData('.app-state.json');
    expect(JSON.parse(raw!).e2eePassword).toBe('hunter2');
    expect(keyring.value.has('pw')).toBe(false);
    expect(svc.hasStoredSyncPassword()).toBe(false);
  });

  it('loads an existing keyring password on restart (no legacy field on disk)', async () => {
    const { platform, svc } = await fresh();
    keyring.value.set('pw', 'from-keyring');
    await platform.testFS.writeAppData('.app-state.json', seedAppState({}));

    await svc.initSyncPassword();

    expect(svc.hasStoredSyncPassword()).toBe(true);
    expect(svc.isE2eeConfigured()).toBe(true);
  });

  it('forgetStoredSyncPassword deletes the keyring entry', async () => {
    const { platform, svc } = await fresh();
    keyring.value.set('pw', 'from-keyring');
    await platform.testFS.writeAppData('.app-state.json', seedAppState({}));
    await svc.initSyncPassword();
    expect(svc.hasStoredSyncPassword()).toBe(true);

    await svc.forgetStoredSyncPassword();

    expect(keyring.value.has('pw')).toBe(false);
    expect(svc.hasStoredSyncPassword()).toBe(false);
  });

  it('never persists the password to .app-state.json on connect', async () => {
    const { platform, svc } = await fresh();
    // e2ee_connect is invoked by connectE2ee; return a plausible connect output.
    const core = await import('@tauri-apps/api/core');
    vi.mocked(core.invoke).mockImplementation(
      async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'e2ee_connect')
          return { userId: 'u', collectionId: 'c', token: 't', authMode: 'password' };
        if (cmd === 'e2ee_password_set') {
          keyring.value.set('pw', (args!.password as string) ?? '');
          return undefined;
        }
        return undefined;
      },
    );

    await svc.connectE2ee('http://server', 'top-secret');

    const raw = await platform.testFS.readAppData('.app-state.json');
    expect(raw).not.toContain('top-secret');
    expect(JSON.parse(raw!).e2eePassword).toBeUndefined();
    expect(keyring.value.get('pw')).toBe('top-secret');
    expect(svc.hasStoredSyncPassword()).toBe(true);
  });
});

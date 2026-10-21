// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREFS,
  deferred,
  flush,
  fresh,
  kr,
  reboot,
  resetPasswordHarness,
  seedAppState,
} from './__test__/syncPasswordHarness';

beforeEach(resetPasswordHarness);

it('moves a legacy bearer token into the keyring and scrubs the vault file', async () => {
  const { platform, svc } = await fresh();
  await platform.testFS.writeAppData(
    '.app-state.json',
    seedAppState({ e2eeAuthToken: 'legacy-token' }),
  );
  kr.store.set('pw', 'vault-password');

  await svc.initSyncPassword();

  expect(kr.store.get('token')).toBe('legacy-token');
  const raw = await platform.testFS.readAppData('.app-state.json');
  expect(JSON.parse(raw!).e2eeAuthToken).toBeUndefined();
  expect(svc.isE2eeConfigured()).toBe(true);
});

it('never persists a newly issued bearer token in the vault file', async () => {
  const { platform, svc } = await fresh();
  await svc.connectE2ee('http://server', 'vault-password');

  const raw = await platform.testFS.readAppData('.app-state.json');
  expect(JSON.parse(raw!).e2eeAuthToken).toBeUndefined();
  expect(kr.store.get('token')).toBe('t');
});

it('resumes with the keyring token after restart', async () => {
  const { svc } = await fresh();
  await svc.connectE2ee('http://server', 'vault-password');

  const b = await reboot();
  await b.svc.initSyncPassword();
  const { invoke } = await import('@tauri-apps/api/core');
  vi.mocked(invoke).mockClear();
  await b.svc.syncE2eeAuto();

  expect(invoke).toHaveBeenCalledWith('e2ee_resume', {
    input: {
      serverUrl: 'http://server',
      token: 't',
      userId: 'u',
      collectionId: 'c',
      password: 'vault-password',
    },
  });
});

it('reauthenticates from the saved password when the keyring token is missing', async () => {
  const { svc } = await fresh();
  await svc.connectE2ee('http://server', 'vault-password');
  kr.store.delete('token');

  const b = await reboot();
  await b.svc.initSyncPassword();
  const { invoke } = await import('@tauri-apps/api/core');
  vi.mocked(invoke).mockClear();
  await b.svc.syncE2eeAuto();

  expect(invoke).toHaveBeenCalledWith('e2ee_connect', {
    input: { serverUrl: 'http://server', password: 'vault-password' },
  });
});

it('does not resurrect a legacy token after a pending credential deletion', async () => {
  const { platform, svc } = await fresh();
  await platform.testFS.writeAppData(
    '.app-state.json',
    seedAppState({ e2eeAuthToken: 'legacy-token', pendingKeyringDeletion: true }),
  );
  kr.store.set('pw', 'old-password');
  kr.store.set('token', 'legacy-token');

  await svc.initSyncPassword();

  expect(kr.store.has('token')).toBe(false);
  expect(kr.store.has('pw')).toBe(false);
  const raw = await platform.testFS.readAppData('.app-state.json');
  expect(JSON.parse(raw!).e2eeAuthToken).toBeUndefined();
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

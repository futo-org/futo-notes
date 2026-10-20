// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PREFS,
  fresh,
  kr,
  liveStartCount,
  reboot,
  resetPasswordHarness,
  seedAppState,
} from './__test__/syncPasswordHarness';

beforeEach(resetPasswordHarness);

// PKT-17: on a DIRECT upgrade from a pre-port build, `.app-state.json` holds
// both the plaintext `e2eePassword` AND the legacy `e2eeObjectMap` /
// `e2eeMaxVersion`. Boot runs initSyncPassword(), which migrates the password
// and then saves the sanitized state — which does NOT carry the legacy map. That
// save must NOT erase the map before the user's first connect runs the Rust
// import, or the whole pre-port cohort lands on the empty-map conflict path.
const LEGACY_MAP = {
  'note.md': {
    objectId: 'o9',
    version: 4,
    blobKey: 'bk-o9-v4',
    hash: 'stale',
    mtimeMs: 1,
    sizeBytes: 5,
  },
};

describe('PKT-17 — legacy sync-state holdover across the boot keyring migration', () => {
  it('preserves e2eeObjectMap / e2eeMaxVersion when the boot migration scrubs the password', async () => {
    const { platform, svc } = await fresh();
    await platform.testFS.writeAppData(
      '.app-state.json',
      seedAppState({ e2eePassword: 'hunter2', e2eeObjectMap: LEGACY_MAP, e2eeMaxVersion: 7 }),
    );

    await svc.initSyncPassword();

    const parsed = JSON.parse((await platform.testFS.readAppData('.app-state.json'))!);
    // The password migrated to the keyring and was scrubbed from disk …
    expect(kr.store.get('pw')).toBe('hunter2');
    expect(parsed.e2eePassword).toBeUndefined();
    // … but the legacy object map + cursor + collection tag survive for the
    // Rust import that has not run yet (no `.e2ee-state.json` exists).
    expect(parsed.e2eeObjectMap).toEqual(LEGACY_MAP);
    expect(parsed.e2eeMaxVersion).toBe(7);
    expect(parsed.e2eeCollectionId).toBe('collection');
  });

  it('keeps the map across an unrelated interleaved save until the import runs', async () => {
    const { platform, appState, svc } = await fresh();
    await platform.testFS.writeAppData(
      '.app-state.json',
      seedAppState({ e2eeObjectMap: LEGACY_MAP, e2eeMaxVersion: 7 }),
    );
    await svc.initSyncPassword(); // no password to migrate; loads app-state

    // A totally unrelated save (e.g. a theme change) must not drop the map.
    await appState.savePreferences(PREFS);

    const parsed = JSON.parse((await platform.testFS.readAppData('.app-state.json'))!);
    expect(parsed.e2eeObjectMap).toEqual(LEGACY_MAP);
    expect(parsed.e2eeMaxVersion).toBe(7);
  });

  it('does NOT scrub the map while .e2ee-state.json is still absent (import not yet run)', async () => {
    const { platform, svc } = await fresh();
    await platform.testFS.writeAppData(
      '.app-state.json',
      seedAppState({ e2eeObjectMap: LEGACY_MAP, e2eeMaxVersion: 7 }),
    );
    await svc.initSyncPassword();

    // A connect whose Rust side has NOT persisted `.e2ee-state.json` (the mock
    // e2ee_connect is a no-op): the holdover must stay so the map is not lost.
    await svc.connectE2ee('http://server', 'pw');

    const parsed = JSON.parse((await platform.testFS.readAppData('.app-state.json'))!);
    expect(parsed.e2eeObjectMap).toEqual(LEGACY_MAP);
  });

  it('scrubs the map once .e2ee-state.json exists (import consumed it)', async () => {
    const { platform, svc } = await fresh();
    await platform.testFS.writeAppData(
      '.app-state.json',
      seedAppState({ e2eeObjectMap: LEGACY_MAP, e2eeMaxVersion: 7 }),
    );
    await svc.initSyncPassword();
    // Rust connect/sync persists this after importing the legacy map.
    await platform.testFS.writeAppData(
      '.e2ee-state.json',
      '{"version":1,"object_map":{},"max_version":0,"collection_id":"collection"}',
    );

    await svc.connectE2ee('http://server', 'pw');

    const parsed = JSON.parse((await platform.testFS.readAppData('.app-state.json'))!);
    expect(parsed.e2eeObjectMap).toBeUndefined();
    expect(parsed.e2eeMaxVersion).toBeUndefined();
  });

  it('best-effort: a rejected scrub write does not fail the committed sync, holdover kept', async () => {
    const { platform, appState, svc } = await fresh();
    await platform.testFS.writeAppData(
      '.app-state.json',
      seedAppState({ e2eeObjectMap: LEGACY_MAP, e2eeMaxVersion: 7 }),
    );
    // The keyring holds the password, so the auto-sync path can resume the session.
    kr.store.set('pw', 'pw');
    await svc.initSyncPassword();
    // Rust imported + persisted `.e2ee-state.json`, so the scrub would fire …
    await platform.testFS.writeAppData(
      '.e2ee-state.json',
      '{"version":1,"object_map":{},"max_version":0,"collection_id":"collection"}',
    );

    // … but the scrub's app-state write transiently rejects. The sync itself has
    // already committed server-side, so a failed cleanup must NOT reject it.
    const failingFS = {
      ...platform.testFS,
      async writeAppData() {
        throw new Error('disk full');
      },
    };
    platform.setActiveFS(failingFS);
    try {
      await expect(svc.syncE2eeAuto()).resolves.toBeUndefined();
      // Holdover retained → the map is not lost and the scrub retries next cycle.
      expect(appState.getLegacySyncState()).toBeDefined();
    } finally {
      platform.resetActiveFS();
    }

    // The map is still on disk (the failed scrub wrote nothing).
    const parsed = JSON.parse((await platform.testFS.readAppData('.app-state.json'))!);
    expect(parsed.e2eeObjectMap).toEqual(LEGACY_MAP);
  });
});

describe('one sync credential at a time (hosted vs self-hosted)', () => {
  // Device QA, 2026-09-16: the stored sync password is app-global rather than
  // per-vault, and every shell tries it before the hosted branch — so a device
  // that had ever connected to someone's own server reconnected there at every
  // launch and never resumed its hosted session. The rule that removes the
  // ambiguity lives in Rust (`HostedSetup::connect_sync`); what these pin is
  // that the desktop shell's synchronous view of the keyring follows it
  // instead of going on reporting a password that is gone.

  it('a hosted connect leaves no self-hosted password, in the keyring or in memory', async () => {
    const { platform, svc } = await fresh();
    await platform.testFS.writeAppData('.app-state.json', seedAppState({}));
    kr.store.set('pw', 'the password for my own server');
    await svc.initSyncPassword();
    expect(svc.hasStoredSyncPassword()).toBe(true);

    await svc.connectHostedE2ee();

    expect(kr.store.get('pw')).toBeUndefined();
    expect(svc.hasStoredSyncPassword()).toBe(false);
    expect(svc.isE2eeConfigured()).toBe(true); // hosted, not password
  });

  it('switching to hosted leaves the live stream startable, not stuck "already running"', async () => {
    // D8's desktop half. Rust stops the old session's live loop inside
    // `connect_hosted`, so a shell that still believes its stream is running
    // makes `ensureLiveSync` a no-op and the hosted session never gets one.
    const { platform, svc } = await fresh();
    await platform.testFS.writeAppData('.app-state.json', seedAppState({}));
    kr.store.set('pw', 'the password for my own server');
    await svc.initSyncPassword();

    await svc.ensureLiveSync();
    expect(liveStartCount()).toBe(1);

    await svc.connectHostedE2ee();
    await svc.ensureLiveSync();

    expect(liveStartCount()).toBe(2);
  });

  it('the launch that resumes a hosted vault does not resurrect the password', async () => {
    const { platform, svc } = await fresh();
    await platform.testFS.writeAppData('.app-state.json', seedAppState({}));
    kr.store.set('pw', 'the password for my own server');
    await svc.initSyncPassword();
    await svc.connectHostedE2ee();

    // Force-quit and relaunch: the keyring is what survives, and the boot
    // resume reads it. This is the exact scenario that found the bug.
    kr.hostedVault = true;
    const relaunched = await reboot();
    await relaunched.svc.initSyncPassword();

    expect(relaunched.svc.hasStoredSyncPassword()).toBe(false);
    expect(relaunched.svc.isE2eeConfigured()).toBe(true);
  });
});

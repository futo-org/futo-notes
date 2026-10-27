// @vitest-environment jsdom
//
// The hosted sync section's puppet verbs, driven by a stand-in state machine.
//
// The wizard itself is owned by Rust's hosted_scenarios and Kotlin's
// HostedSetupModelTest; what is tested here is the agent's side of each screen:
// which verbs a step offers, and that each calls what its button calls.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import HostedSyncSettingsSection from './HostedSyncSettingsSection.svelte';
import type { HostedSyncSettings } from './createHostedSyncSettings.svelte';
import type { SyncSettings } from './createSyncSettings.svelte';
import type { BillingStatusOutput } from '$features/sync/syncContract.generated';
import { registeredVerbs } from '$app/puppet/puppetRegistry';

function billing(overrides: Partial<BillingStatusOutput> = {}): BillingStatusOutput {
  return {
    entitled: true,
    state: 'active',
    graceUntil: null,
    storageQuotaBytes: 10_000_000_000,
    blobMaxBytes: 104_857_600,
    bytesUsed: 1_500_000_000,
    ...overrides,
  };
}

function hostedStub(overrides: Partial<HostedSyncSettings> = {}): HostedSyncSettings {
  return {
    screen: 'signIn',
    busy: false,
    waiting: null,
    error: '',
    serverUrl: 'https://notes-sync.futo.org',
    email: 'person@standin.test',
    billing: null,
    banner: 'none',
    recoveryKey: null,
    recoveryKeyReplaced: false,
    minVaultPasswordLength: 12,
    recoveryKeySaved: false,
    unlockDoor: 'vaultPassword',
    selfHostedOpen: false,
    pairing: 'idle',
    pairingPayload: null,
    pairingExpiresAt: null,
    load: vi.fn(async () => {}),
    signIn: vi.fn(async () => {}),
    cancelWaiting: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
    createVault: vi.fn(async () => {}),
    copyRecoveryKey: vi.fn(async () => {}),
    saveRecoveryKeyToFile: vi.fn(async () => {}),
    continueAfterRecoveryKey: vi.fn(async () => {}),
    unlockWithPassword: vi.fn(async () => {}),
    unlockWithRecoveryKey: vi.fn(async () => {}),
    showPairingCode: vi.fn(async () => {}),
    cancelPairing: vi.fn(async () => {}),
    manageSubscription: vi.fn(async () => {}),
    beginChangeVaultPassword: vi.fn(),
    changeVaultPassword: vi.fn(async () => {}),
    newRecoveryKey: vi.fn(async () => {}),
    backToAccount: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Today's self-hosted settings; only ever read through the disclosure. */
function syncStub(): SyncSettings {
  return {
    url: '',
    password: '',
    busy: false,
    status: '',
    lastSyncedAt: null,
    connected: false,
    passwordSaved: false,
    connecting: false,
    connectPhase: '',
    connectError: '',
    connect: vi.fn(async () => {}),
    cancelConnect: vi.fn(),
    resetConnection: vi.fn(async () => {}),
    forgetPassword: vi.fn(async () => {}),
    handleUrlClick: vi.fn(),
    syncNow: vi.fn(async () => {}),
  } as unknown as SyncSettings;
}

let target: HTMLDivElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
});

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target.remove();
});

function render(overrides: Partial<HostedSyncSettings> = {}): HostedSyncSettings {
  const hosted = hostedStub(overrides);
  app = mount(HostedSyncSettingsSection, {
    target,
    props: {
      hosted,
      sync: syncStub(),
      backgroundError: false,
      backgroundErrorMessage: '',
      reconnecting: false,
    },
  });
  return hosted;
}

describe("the agent's verbs: each step's controls, while that step is up", () => {
  const offered = (): string[] => (flushSync(), registeredVerbs().map((verb) => verb.name));
  const run = (name: string, args: Record<string, unknown> = {}) =>
    registeredVerbs()
      .find((verb) => verb.name === name)!
      .run(args);

  it('sign-in: Log in with FUTO and Use my own server, and nothing from later steps', async () => {
    const hosted = render({ screen: 'signIn' });
    expect(offered()).toEqual(['SignInWithFuto', 'ToggleOwnServer']);
    await run('SignInWithFuto');
    expect(hosted.signIn).toHaveBeenCalled();
  });

  it('a disabled button refuses rather than doing nothing', async () => {
    const hosted = render({ screen: 'subscribe', busy: true });
    offered();
    expect((await run('Subscribe')).status).toBe(409);
    expect(hosted.subscribe).not.toHaveBeenCalled();
  });

  it('CreateVault types both fields, and a short password is left on screen, refused', async () => {
    const hosted = render({ screen: 'createVault' });
    offered();
    expect((await run('CreateVault', { vaultPassword: 'short' })).status).toBe(409);
    expect(target.querySelector<HTMLInputElement>('#hosted-vault-password')!.value).toBe('short');
    expect(hosted.createVault).not.toHaveBeenCalled();

    expect((await run('CreateVault', { vaultPassword: 'long enough to count' })).status).toBe(200);
    expect(hosted.createVault).toHaveBeenCalledWith('long enough to count');
  });

  it('the recovery key: Continue waits for the checkbox, and Save takes a path', async () => {
    const hosted = render({ screen: 'recoveryKey', recoveryKey: 'ABCD-EFGH' });
    expect(offered()).toEqual(
      expect.arrayContaining(['CopyRecoveryKey', 'SaveRecoveryKey', 'SetRecoveryKeySaved']),
    );
    expect((await run('ContinueRecoveryKey')).status).toBe(409);
    await run('SaveRecoveryKey', { path: '/tmp/key.txt' });
    expect(hosted.saveRecoveryKeyToFile).toHaveBeenCalledWith('/tmp/key.txt');
    await run('SetRecoveryKeySaved', { saved: true });
    expect(hosted.recoveryKeySaved).toBe(true);
  });

  it('unlock: Unlock takes the open field, and a method is named for what it is', async () => {
    const hosted = render({ screen: 'unlock', unlockDoor: 'vaultPassword' });
    offered();
    expect(await run('UnlockVault', { vaultPassword: '' })).toMatchObject({ status: 409 });
    expect(hosted.unlockWithPassword).not.toHaveBeenCalled();
    await run('UnlockVault', { vaultPassword: 'rhubarb crumble' });
    expect(hosted.unlockWithPassword).toHaveBeenCalledWith('rhubarb crumble');
    await run('SelectUnlockMethod', { method: 'anotherDevice' });
    expect(hosted.unlockDoor).toBe('scan');
  });

  it('the account card: Sign out goes through its confirmation', async () => {
    const hosted = render({ screen: 'account', billing: billing() });
    expect(offered()).toEqual(
      expect.arrayContaining(['ManageSubscription', 'ReplaceRecoveryKey', 'SignOutOfFuto']),
    );
    await run('SignOutOfFuto', {});
    expect(hosted.signOut).toHaveBeenCalled();
  });
});

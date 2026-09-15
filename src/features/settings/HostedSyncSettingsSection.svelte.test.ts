// @vitest-environment jsdom
//
// The hosted sync section, driven by a stand-in state machine.
//
// Nothing here reaches Tauri, Rust, or a server: the section renders from one
// `HostedSyncSettings` object and holds no state of its own, so every screen
// and every banner is reachable by handing it one. What each test asserts is
// what a person would see on that screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';

import HostedSyncSettingsSection from './HostedSyncSettingsSection.svelte';
import type { HostedSyncSettings } from './createHostedSyncSettings.svelte';
import type { SyncSettings } from './createSyncSettings.svelte';
import type { BillingStatusOutput } from '$features/sync/syncContract.generated';

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
    minVaultPasswordLength: 12,
    recoveryKeySaved: false,
    unlockDoor: 'vaultPassword',
    selfHostedOpen: false,
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
    manageSubscription: vi.fn(async () => {}),
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

const text = (): string => target.textContent ?? '';
const button = (label: string): HTMLButtonElement | undefined =>
  [...target.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);

describe('every step of both wizard shapes', () => {
  it('says it is checking before Rust has answered', () => {
    render({ screen: 'loading' });
    expect(text()).toContain('Checking your account');
    expect(button('Log in with FUTO')).toBeUndefined();
  });

  it('leads with Log in with FUTO and names where sign-in happens', () => {
    render({ screen: 'signIn' });
    expect(button('Log in with FUTO')).toBeDefined();
    expect(text()).toContain('notes-sync.futo.org');
  });

  it('offers the subscription on the subscribe step', () => {
    render({ screen: 'subscribe' });
    expect(button('Subscribe')).toBeDefined();
    expect(text()).toContain('Subscribe to FUTO sync');
  });

  it('asks for a vault password and says it is never sent anywhere', () => {
    render({ screen: 'createVault' });
    expect(target.querySelector('#hosted-vault-password')).not.toBeNull();
    expect(target.querySelector('#hosted-vault-password-repeat')).not.toBeNull();
    expect(text()).toContain('never sent anywhere');
    expect(text()).toContain('At least 12 characters');
  });

  it('keeps Create vault disabled until the password is long enough and matches', async () => {
    const hosted = render({ screen: 'createVault' });
    const password = target.querySelector<HTMLInputElement>('#hosted-vault-password')!;
    const repeat = target.querySelector<HTMLInputElement>('#hosted-vault-password-repeat')!;

    await type(password, 'short');
    expect(button('Create vault')?.disabled).toBe(true);

    await type(password, 'rhubarb crumble');
    await type(repeat, 'rhubarb crumbl');
    expect(button('Create vault')?.disabled).toBe(true);
    expect(text()).toContain('Those two passwords are different');

    await type(repeat, 'rhubarb crumble');
    expect(button('Create vault')?.disabled).toBe(false);
    button('Create vault')!.click();
    expect(hosted.createVault).toHaveBeenCalledWith('rhubarb crumble');
  });

  it('shows the strength meter moving with the password', async () => {
    render({ screen: 'createVault' });
    const password = target.querySelector<HTMLInputElement>('#hosted-vault-password')!;

    await type(password, 'aaa');
    expect(text()).toContain('At least 12 characters');

    await type(password, 'aaaaaaaaaaaaaaaa');
    expect(text()).toContain('Weak');

    await type(password, 'Tr0ubadour&Horse!');
    expect(text()).toContain('Strong');
  });
});

describe('the recovery-key screen', () => {
  it('shows the recovery key with Copy, Save file, and the unrecoverable warning', () => {
    render({ screen: 'recoveryKey', recoveryKey: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345' });
    expect(text()).toContain('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345');
    expect(button('Copy')).toBeDefined();
    expect(button('Save file')).toBeDefined();
    expect(text()).toContain('FUTO cannot recover your vault without it');
    expect(text()).toContain('You will not be shown this key again');
  });

  it('gates Continue on the saved checkbox', () => {
    render({ screen: 'recoveryKey', recoveryKey: 'ABCD-EFGH', recoveryKeySaved: false });
    expect(button('Continue')?.disabled).toBe(true);
  });

  it('lets Continue through once the checkbox is ticked', () => {
    const hosted = render({
      screen: 'recoveryKey',
      recoveryKey: 'ABCD-EFGH',
      recoveryKeySaved: true,
    });
    expect(button('Continue')?.disabled).toBe(false);
    button('Continue')!.click();
    expect(hosted.continueAfterRecoveryKey).toHaveBeenCalled();
  });

  it('renders nothing of the key once the state machine no longer holds one', () => {
    // There is no way back to this screen: the key lives only in the object
    // that create_vault handed it to, and Rust keeps no copy to hand over
    // again. A `recoveryKey` screen without a key falls through to nothing.
    render({ screen: 'recoveryKey', recoveryKey: null });
    expect(button('Continue')).toBeUndefined();
    expect(text()).not.toContain('Save your recovery key');
  });
});

describe('the three unlock doors', () => {
  it('offers all three unlock doors on one screen', () => {
    render({ screen: 'unlock' });
    expect(button('Vault password')).toBeDefined();
    expect(button('Scan from another device')).toBeDefined();
    expect(button('Recovery key')).toBeDefined();
  });

  it('unlocks with the vault password through the first door', async () => {
    const hosted = render({ screen: 'unlock', unlockDoor: 'vaultPassword' });
    const field = target.querySelector<HTMLInputElement>('#hosted-unlock-password')!;
    expect(field.type).toBe('password');
    await type(field, 'rhubarb crumble');
    button('Unlock')!.click();
    expect(hosted.unlockWithPassword).toHaveBeenCalledWith('rhubarb crumble');
  });

  it('says plainly that the scan door is not ready instead of doing nothing', () => {
    render({ screen: 'unlock', unlockDoor: 'scan' });
    expect(text()).toContain('not available yet');
    expect(button('Unlock')).toBeUndefined();
  });

  it('unlocks with a typed recovery key through the third door', async () => {
    const hosted = render({ screen: 'unlock', unlockDoor: 'recoveryKey' });
    const field = target.querySelector<HTMLInputElement>('#hosted-unlock-recovery-key')!;
    await type(field, 'abcd efgh');
    button('Unlock')!.click();
    expect(hosted.unlockWithRecoveryKey).toHaveBeenCalledWith('abcd efgh');
  });
});

describe('the account card', () => {
  it('shows email, subscription state in words, storage used, and the portal', () => {
    const hosted = render({ screen: 'account', billing: billing() });
    expect(text()).toContain('person@standin.test');
    expect(text()).toContain('Active');
    expect(text()).toContain('1.5 GB of 10 GB used');
    button('Manage subscription')!.click();
    expect(hosted.manageSubscription).toHaveBeenCalled();
  });

  it('offers Sign out from the account card', () => {
    const hosted = render({ screen: 'account', billing: billing() });
    button('Sign out')!.click();
    expect(hosted.signOut).toHaveBeenCalled();
  });

  it('says when a past-due subscription stops syncing', () => {
    const graceUntil = new Date(Date.now() + 5.5 * 24 * 60 * 60 * 1000).toISOString();
    render({ screen: 'account', billing: billing({ state: 'past_due', graceUntil }) });
    expect(text()).toContain('Payment failed');
    expect(text()).toContain('In 5 days, sync pauses');
  });
});

describe('one test per banner state', () => {
  it('shows no banner on a healthy account', () => {
    render({ screen: 'account', banner: 'none', billing: billing() });
    expect(text()).not.toContain('Sync paused');
    expect(text()).not.toContain('Vault is full');
  });

  it('shows Sync paused with Subscribe, and says reads still arrive', () => {
    const hosted = render({
      screen: 'account',
      banner: 'syncPaused',
      billing: billing({ entitled: false, state: 'canceled' }),
    });
    expect(text()).toContain('Sync paused');
    expect(text()).toContain('still arrive');
    button('Subscribe')!.click();
    expect(hosted.subscribe).toHaveBeenCalled();
  });

  it('shows Vault is full with the portal button', () => {
    const hosted = render({
      screen: 'account',
      banner: 'vaultFull',
      billing: billing({ bytesUsed: 10_000_000_000 }),
    });
    expect(text()).toContain('Vault is full');
    button('Manage subscription')!.click();
    expect(hosted.manageSubscription).toHaveBeenCalled();
  });
});

describe('waiting, errors, and the self-hosted disclosure', () => {
  it('says a browser window is open and offers to stop waiting', () => {
    const hosted = render({ screen: 'signIn', waiting: 'signIn' });
    expect(text()).toContain('Finish signing in in your browser');
    button('Cancel')!.click();
    expect(hosted.cancelWaiting).toHaveBeenCalled();
  });

  it('shows a failure as a sentence with an alert role', () => {
    render({ screen: 'signIn', error: 'Couldn’t reach the server.' });
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Couldn’t reach');
  });

  it('says so when the address offers no FUTO accounts at all', () => {
    render({ screen: 'unavailable' });
    expect(text()).toContain("doesn't offer FUTO accounts");
  });

  it('hides today self-hosted fields behind Use my own server', () => {
    render({ screen: 'signIn', selfHostedOpen: false });
    expect(button('Use my own server')).toBeDefined();
    expect(target.querySelector('#sync-url')).toBeNull();
  });

  it('reveals exactly today self-hosted URL and password fields when opened', () => {
    render({ screen: 'signIn', selfHostedOpen: true });
    expect(target.querySelector('#sync-url')).not.toBeNull();
    expect(target.querySelector('#sync-password')).not.toBeNull();
    expect(button('Connect')).toBeDefined();
  });

  it('drops the self-hosted offer once hosted sync is set up', () => {
    render({ screen: 'account', billing: billing() });
    expect(button('Use my own server')).toBeUndefined();
  });
});

/** Types into a bound input the way Svelte 5 listens for it. */
async function type(field: HTMLInputElement, value: string): Promise<void> {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await Promise.resolve();
}

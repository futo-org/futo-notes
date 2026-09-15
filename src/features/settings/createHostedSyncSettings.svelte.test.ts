// @vitest-environment jsdom
//
// The hosted controller against a stand-in for the Rust state machine.
//
// The rule these tests exist to hold: the wizard's position is whatever
// `e2ee_hosted_current_step` says and nothing else. Anything that looks like a
// remembered step would show up here as a screen that disagrees with the stub.
import { describe, expect, it, vi } from 'vitest';

import type { BillingStatusOutput, SetupStepOutput } from '$features/sync/syncContract.generated';

const rust = vi.hoisted(() => ({
  hostedServerUrl: vi.fn(async () => 'https://notes-sync.futo.org'),
  probeSignInFlow: vi.fn(async () => ({ kind: 'hosted', sellsSubscriptions: true })),
  minVaultPasswordLength: vi.fn(async () => 12),
  hostedCurrentStep: vi.fn(async (): Promise<SetupStepOutput> => ({ kind: 'signIn' })),
  hostedSession: vi.fn(async () => ({
    userId: 'u',
    email: 'person@standin.test',
    name: 'Person',
    token: 't',
  })),
  hostedBillingStatus: vi.fn(async () => ({
    entitled: true,
    state: 'active',
    graceUntil: null,
    storageQuotaBytes: 10_000_000_000,
    blobMaxBytes: 104_857_600,
    bytesUsed: 1_000,
  })),
  beginHostedSignIn: vi.fn(async () => ({ url: 'https://login.example/t', ticket: 't' })),
  awaitHostedSignIn: vi.fn(async () => ({ kind: 'cancelled' })),
  cancelHostedWait: vi.fn(async () => {}),
  beginHostedCheckout: vi.fn(async () => ({ kind: 'open', url: 'https://pay.example' })),
  awaitHostedEntitled: vi.fn(async () => ({ kind: 'cancelled' })),
  hostedBillingPortal: vi.fn(async () => 'https://portal.example'),
  createHostedVault: vi.fn(async () => 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345'),
  unlockWithVaultPassword: vi.fn(async () => {}),
  unlockWithRecoveryKey: vi.fn(async () => {}),
  hostedSignOut: vi.fn(async () => {}),
  saveTextFile: vi.fn(async () => true),
}));
vi.mock('$lib/platform/tauri', () => rust);

const openExternalUrl = vi.hoisted(() => vi.fn());
vi.mock('$lib/platform/openExternalUrl', () => ({ openExternalUrl }));

const writeClipboardText = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$lib/platform', () => ({
  getPlatformFS: async () => ({ writeClipboardText }),
  isTauri: true,
}));

const confirmDialog = vi.hoisted(() => vi.fn(async () => true));
vi.mock('$shared/dialogs/confirmDialog', () => ({ confirmDialog }));

const showGlobalToast = vi.hoisted(() => vi.fn());
vi.mock('$shared/notifications/toastBus.svelte', () => ({ showGlobalToast }));

import { createHostedSyncSettings } from './createHostedSyncSettings.svelte';

function billing(overrides: Partial<BillingStatusOutput> = {}): BillingStatusOutput {
  return {
    entitled: true,
    state: 'active',
    graceUntil: null,
    storageQuotaBytes: 10_000_000_000,
    blobMaxBytes: 104_857_600,
    bytesUsed: 1_000,
    ...overrides,
  };
}

/** Whatever Rust would answer `current_step` with from here on. */
function stepIs(kind: SetupStepOutput['kind']): void {
  rust.hostedCurrentStep.mockResolvedValue({ kind } as SetupStepOutput);
}

// `mockReset: true` (vitest.config.ts) puts every stub back to the
// implementation it was created with between tests, so each test only says how
// it differs from the happy path above.

describe('the wizard position is Rust’s, not the shell’s', () => {
  it.each([
    ['signIn', 'signIn'],
    ['subscribe', 'subscribe'],
    ['createVault', 'createVault'],
    ['unlock', 'unlock'],
    ['ready', 'account'],
  ] as const)('renders %s as the %s screen', async (step, screen) => {
    stepIs(step);
    const hosted = createHostedSyncSettings();
    await hosted.load();
    expect(hosted.screen).toBe(screen);
  });

  it('resumes mid-wizard on a cold start, because nothing here remembers a step', async () => {
    // A fresh controller — exactly what reopening the app gives you — lands on
    // whatever the server and this device's secret store now imply.
    stepIs('unlock');
    const reopened = createHostedSyncSettings();
    await reopened.load();
    expect(reopened.screen).toBe('unlock');
    expect(rust.hostedCurrentStep).toHaveBeenCalled();
  });

  it('re-asks after every step rather than advancing on its own', async () => {
    stepIs('unlock');
    const hosted = createHostedSyncSettings();
    await hosted.load();

    // Unlocking succeeded, but this controller does not decide what comes next.
    stepIs('ready');
    await hosted.unlockWithPassword('rhubarb crumble');

    expect(rust.unlockWithVaultPassword).toHaveBeenCalledWith('rhubarb crumble');
    expect(hosted.screen).toBe('account');
  });

  it('shows the section as unavailable when the address offers no hosted sign-in', async () => {
    rust.probeSignInFlow.mockResolvedValue({ kind: 'password' });
    const hosted = createHostedSyncSettings();
    await hosted.load();
    expect(hosted.screen).toBe('unavailable');
    expect(rust.hostedCurrentStep).not.toHaveBeenCalled();
  });
});

describe('signing in', () => {
  it('opens the hand-off URL through the app’s own opener', async () => {
    const hosted = createHostedSyncSettings();
    await hosted.load();
    await hosted.signIn();
    expect(openExternalUrl).toHaveBeenCalledWith('https://login.example/t');
  });

  it('leaves no error and no half state when the browser window is abandoned', async () => {
    rust.awaitHostedSignIn.mockResolvedValue({ kind: 'cancelled' });
    const hosted = createHostedSyncSettings();
    await hosted.load();
    await hosted.signIn();
    expect(hosted.error).toBe('');
    expect(hosted.screen).toBe('signIn');
    expect(hosted.waiting).toBeNull();
  });

  it('asks Rust where to go next once the person has signed in', async () => {
    rust.awaitHostedSignIn.mockResolvedValue({
      kind: 'signedIn',
      session: { userId: 'u', email: 'person@standin.test', name: 'Person', token: 't' },
    });
    stepIs('subscribe');
    const hosted = createHostedSyncSettings();
    await hosted.load();
    await hosted.signIn();
    expect(hosted.screen).toBe('subscribe');
    expect(hosted.email).toBe('person@standin.test');
  });

  it('reports an expired hand-off as something to try again', async () => {
    rust.awaitHostedSignIn.mockResolvedValue({ kind: 'expired' });
    const hosted = createHostedSyncSettings();
    await hosted.load();
    await hosted.signIn();
    expect(hosted.error).toContain('too long');
  });

  it('reports an expired session as sign in again, never as a lost vault', async () => {
    rust.hostedCurrentStep.mockRejectedValue({ kind: 'signInAgain' });
    const hosted = createHostedSyncSettings();
    await hosted.load();
    expect(hosted.error).toContain('Log in with FUTO again');
    expect(hosted.error).toContain('untouched');
  });
});

describe('subscribing', () => {
  it('opens checkout and moves on when the account becomes entitled', async () => {
    stepIs('subscribe');
    const hosted = createHostedSyncSettings();
    await hosted.load();

    rust.awaitHostedEntitled.mockResolvedValue({ kind: 'entitled', status: billing() });
    stepIs('createVault');
    await hosted.subscribe();

    expect(openExternalUrl).toHaveBeenCalledWith('https://pay.example');
    expect(hosted.screen).toBe('createVault');
  });

  it('never sends an already-entitled account to pay twice', async () => {
    stepIs('subscribe');
    const hosted = createHostedSyncSettings();
    await hosted.load();

    rust.beginHostedCheckout.mockResolvedValue({ kind: 'alreadyEntitled', status: billing() });
    stepIs('createVault');
    await hosted.subscribe();

    expect(openExternalUrl).not.toHaveBeenCalledWith(expect.stringContaining('pay.example'));
    expect(hosted.screen).toBe('createVault');
  });
});

describe('the recovery key is handed over once', () => {
  it('shows the key create_vault returned', async () => {
    stepIs('createVault');
    const hosted = createHostedSyncSettings();
    await hosted.load();

    await hosted.createVault('rhubarb crumble');

    expect(rust.createHostedVault).toHaveBeenCalledWith('rhubarb crumble');
    expect(hosted.screen).toBe('recoveryKey');
    expect(hosted.recoveryKey).toBe('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345');
  });

  it('is gone for good once the person continues, with nothing that can fetch it back', async () => {
    stepIs('createVault');
    const hosted = createHostedSyncSettings();
    await hosted.load();
    await hosted.createVault('rhubarb crumble');

    stepIs('ready');
    await hosted.continueAfterRecoveryKey();

    expect(hosted.recoveryKey).toBeNull();
    expect(hosted.screen).toBe('account');

    // The only producer is create_vault, and Rust refuses a second one.
    rust.createHostedVault.mockRejectedValue({ kind: 'vaultAlreadyExists' });
    await hosted.createVault('rhubarb crumble');
    expect(hosted.recoveryKey).toBeNull();
    expect(hosted.error).toContain('already has a vault');
  });

  it('copies the key and writes it to a file the person chooses', async () => {
    stepIs('createVault');
    const hosted = createHostedSyncSettings();
    await hosted.load();
    await hosted.createVault('rhubarb crumble');

    await hosted.copyRecoveryKey();
    expect(writeClipboardText).toHaveBeenCalledWith('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345');

    await hosted.saveRecoveryKeyToFile();
    expect(rust.saveTextFile).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: 'futo-notes-recovery-key.txt',
        // The key alone, so the file pastes straight back into the unlock field.
        contents: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345\n',
      }),
    );
  });
});

describe('unlocking', () => {
  it('reports a mistyped recovery key as a typo', async () => {
    stepIs('unlock');
    const hosted = createHostedSyncSettings();
    await hosted.load();

    rust.unlockWithRecoveryKey.mockRejectedValue({ kind: 'recoveryKeyTypo' });
    await hosted.unlockWithRecoveryKey('ABCD-EFGH');

    expect(hosted.error).toContain('typo');
    expect(hosted.screen).toBe('unlock');
  });

  it('reports a wrong vault password as the one thing you fix by typing again', async () => {
    stepIs('unlock');
    const hosted = createHostedSyncSettings();
    await hosted.load();

    rust.unlockWithVaultPassword.mockRejectedValue({ kind: 'wrongVaultPassword' });
    await hosted.unlockWithPassword('wrong');

    expect(hosted.error).toContain("not this vault's password");
  });
});

describe('the account card', () => {
  it('opens the customer portal in a browser', async () => {
    stepIs('ready');
    const hosted = createHostedSyncSettings();
    await hosted.load();
    await hosted.manageSubscription();
    expect(openExternalUrl).toHaveBeenCalledWith('https://portal.example');
  });

  it('asks before signing out, and does nothing when the answer is no', async () => {
    stepIs('ready');
    const hosted = createHostedSyncSettings();
    await hosted.load();

    confirmDialog.mockResolvedValue(false);
    await hosted.signOut();

    expect(rust.hostedSignOut).not.toHaveBeenCalled();
    expect(hosted.screen).toBe('account');
  });

  it('signs out and re-reads the step, which is back at the beginning', async () => {
    stepIs('ready');
    const hosted = createHostedSyncSettings();
    await hosted.load();

    stepIs('signIn');
    await hosted.signOut();

    expect(rust.hostedSignOut).toHaveBeenCalled();
    expect(hosted.screen).toBe('signIn');
    expect(hosted.email).toBe('');
  });
});

describe('the banners follow the account, not a guess', () => {
  it('stays quiet on a healthy account', async () => {
    stepIs('ready');
    const hosted = createHostedSyncSettings();
    await hosted.load();
    expect(hosted.banner).toBe('none');
  });

  it('says Sync paused once the account may no longer write', async () => {
    stepIs('ready');
    rust.hostedBillingStatus.mockResolvedValue(billing({ entitled: false, state: 'canceled' }));
    const hosted = createHostedSyncSettings();
    await hosted.load();
    expect(hosted.banner).toBe('syncPaused');
  });

  it('says Vault is full once storage is used up', async () => {
    stepIs('ready');
    rust.hostedBillingStatus.mockResolvedValue(
      billing({ bytesUsed: 10_000_000_000, storageQuotaBytes: 10_000_000_000 }),
    );
    const hosted = createHostedSyncSettings();
    await hosted.load();
    expect(hosted.banner).toBe('vaultFull');
  });

  it('prefers Sync paused over Vault is full, because that is the refusal to fix', async () => {
    stepIs('ready');
    rust.hostedBillingStatus.mockResolvedValue(
      billing({ entitled: false, state: 'canceled', bytesUsed: 10_000_000_000 }),
    );
    const hosted = createHostedSyncSettings();
    await hosted.load();
    expect(hosted.banner).toBe('syncPaused');
  });

  it('shows no banner mid-wizard, where there is nothing paused yet', async () => {
    stepIs('subscribe');
    rust.hostedBillingStatus.mockResolvedValue(billing({ entitled: false, state: 'none' }));
    const hosted = createHostedSyncSettings();
    await hosted.load();
    expect(hosted.banner).toBe('none');
  });
});

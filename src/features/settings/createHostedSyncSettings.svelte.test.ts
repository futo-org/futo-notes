// @vitest-environment jsdom
//
// The hosted controller against a stand-in for the Rust state machine.
//
// The rule these tests exist to hold: the wizard's position is whatever
// `e2ee_hosted_current_step` says and nothing else. Anything that looks like a
// remembered step would show up here as a screen that disagrees with the stub.
import { describe, expect, it, vi } from 'vitest';

import type {
  BillingStatusOutput,
  PairingOutcomeOutput,
  SetupStepOutput,
} from '$features/sync/syncContract.generated';

/** The shape Rust's `begin_pairing` actually answers with. */
const PAIRING_PAYLOAD = JSON.stringify({
  futo_notes_pairing: 1,
  id: '01JBXYZABCDEF0123456789ABCD',
  public_key: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
  device_name: 'Kitchen laptop',
  platform: 'desktop',
});

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
  beginPairing: vi.fn(async () => ({
    payload: PAIRING_PAYLOAD,
    expiresAt: '2026-09-15T12:05:00.000Z',
  })),
  awaitPairing: vi.fn(async (): Promise<PairingOutcomeOutput> => ({ kind: 'paired' })),
  hostedSignOut: vi.fn(async () => {}),
  changeVaultPassword: vi.fn(async () => {}),
  newRecoveryKey: vi.fn(async () => 'ZYXW-VTSR-QPNM-KJHG-FEDC-BA98-7654'),
  saveTextFile: vi.fn(async () => true),
}));
vi.mock('$lib/platform/tauri', () => rust);

// The sync side of the world, which this controller only ever asks two things
// of: hand the engine the hosted secrets, then run a cycle.
const sync = vi.hoisted(() => ({
  connectHostedE2ee: vi.fn(async () => {}),
  forgetHostedE2ee: vi.fn(),
  requestSync: vi.fn(async () => ({})),
}));
vi.mock('$features/sync/syncServiceE2ee', () => ({
  connectHostedE2ee: sync.connectHostedE2ee,
  forgetHostedE2ee: sync.forgetHostedE2ee,
}));
vi.mock('$features/sync/autoSync', () => ({ requestSync: sync.requestSync }));

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

describe('showing a pairing code', () => {
  /** A rejected Tauri command: the serialized `HostedError` variant. */
  function rejectsWith(kind: string): void {
    rust.awaitPairing.mockRejectedValue({ kind });
  }

  async function atTheScanDoor() {
    stepIs('unlock');
    const hosted = createHostedSyncSettings();
    await hosted.load();
    return hosted;
  }

  it('asks Rust for a code and waits on it, without naming this computer itself', async () => {
    const hosted = await atTheScanDoor();
    rust.awaitPairing.mockImplementation(
      () => new Promise<PairingOutcomeOutput>(() => {}), // still waiting
    );
    void hosted.showPairingCode();
    await Promise.resolve();
    await Promise.resolve();

    // The desktop has no way to know what this machine is called, so it does
    // not pretend to: Rust fills the name in.
    expect(rust.beginPairing).toHaveBeenCalledWith();
    expect(hosted.pairing).toBe('waiting');
    expect(hosted.pairingPayload).toBe(PAIRING_PAYLOAD);
    expect(hosted.pairingExpiresAt).toBe('2026-09-15T12:05:00.000Z');
  });

  it('paired: keeps the moment visible, then lands on the account card', async () => {
    const hosted = await atTheScanDoor();
    stepIs('ready');
    await hosted.showPairingCode();

    expect(hosted.pairing).toBe('received');
    expect(hosted.pairingPayload).toBeNull();
    expect(hosted.screen).toBe('account');
  });

  it('expired: is a state, not a red error — and is what declining looks like', async () => {
    const hosted = await atTheScanDoor();
    rejectsWith('pairingExpired');
    await hosted.showPairingCode();

    expect(hosted.pairing).toBe('expired');
    expect(hosted.pairingPayload).toBeNull();
    expect(hosted.error).toBe('');
    expect(hosted.screen).toBe('unlock');
  });

  it('refused: a relay that will not serve the pairing is its own state', async () => {
    const hosted = await atTheScanDoor();
    rejectsWith('pairingRefused');
    await hosted.showPairingCode();

    expect(hosted.pairing).toBe('refused');
    expect(hosted.error).toBe('');
  });

  it('refused: a pairing another device already answered reads the same way', async () => {
    const hosted = await atTheScanDoor();
    rejectsWith('pairingAlreadyKeyed');
    await hosted.showPairingCode();

    expect(hosted.pairing).toBe('refused');
  });

  it('reports anything else as the sentence it is, and shows no dead code', async () => {
    const hosted = await atTheScanDoor();
    rejectsWith('network');
    await hosted.showPairingCode();

    expect(hosted.pairing).toBe('idle');
    expect(hosted.error).toContain('reach the server');
  });

  it('cancelling stops the wait in Rust and puts the doors back', async () => {
    const hosted = await atTheScanDoor();
    rust.awaitPairing.mockImplementation(() => new Promise<PairingOutcomeOutput>(() => {}));
    void hosted.showPairingCode();
    await Promise.resolve();
    await Promise.resolve();

    await hosted.cancelPairing();
    expect(rust.cancelHostedWait).toHaveBeenCalled();
    expect(hosted.pairing).toBe('idle');
    expect(hosted.pairingPayload).toBeNull();
  });

  it('showing a new code after an expiry mints a new one rather than resuming', async () => {
    const hosted = await atTheScanDoor();
    rejectsWith('pairingExpired');
    await hosted.showPairingCode();
    expect(rust.beginPairing).toHaveBeenCalledTimes(1);

    rust.awaitPairing.mockResolvedValue({ kind: 'cancelled' });
    await hosted.showPairingCode();
    expect(rust.beginPairing).toHaveBeenCalledTimes(2);
  });
});

describe('reaching a set-up, unlocked vault starts syncing', () => {
  it('hands the engine the hosted secrets and runs one cycle', async () => {
    stepIs('ready');
    const hosted = createHostedSyncSettings();
    await hosted.load();

    expect(hosted.screen).toBe('account');
    expect(sync.connectHostedE2ee).toHaveBeenCalledTimes(1);
    expect(sync.requestSync).toHaveBeenCalledTimes(1);
  });

  it('runs it whichever door got there, pairing included', async () => {
    stepIs('unlock');
    const hosted = createHostedSyncSettings();
    await hosted.load();
    expect(sync.requestSync).not.toHaveBeenCalled();

    stepIs('ready');
    await hosted.showPairingCode();
    expect(sync.connectHostedE2ee).toHaveBeenCalledTimes(1);
    expect(sync.requestSync).toHaveBeenCalledTimes(1);
  });

  it('does not re-sync on every step read, only on arriving', async () => {
    stepIs('ready');
    const hosted = createHostedSyncSettings();
    await hosted.load();
    await hosted.load();
    expect(sync.requestSync).toHaveBeenCalledTimes(1);
  });

  it('never starts a cycle before the vault is unlocked', async () => {
    stepIs('unlock');
    const hosted = createHostedSyncSettings();
    await hosted.load();
    expect(sync.connectHostedE2ee).not.toHaveBeenCalled();
    expect(sync.requestSync).not.toHaveBeenCalled();
  });

  it('reports a failed first sync and tries again when the screen is reopened', async () => {
    stepIs('ready');
    sync.requestSync.mockRejectedValueOnce(new Error('Offline — reconnect to sync'));
    const hosted = createHostedSyncSettings();
    await hosted.load();
    expect(hosted.error).not.toBe('');

    await hosted.load();
    expect(sync.requestSync).toHaveBeenCalledTimes(2);
    expect(hosted.error).toBe('');
  });

  it('signing out ends the hosted session as far as sync is concerned', async () => {
    stepIs('ready');
    const hosted = createHostedSyncSettings();
    await hosted.load();

    stepIs('signIn');
    await hosted.signOut();
    expect(sync.forgetHostedE2ee).toHaveBeenCalled();
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

describe('changing the vault password, and a new recovery key', () => {
  /** A device that finished setup: Rust says ready, so the card is up. */
  async function onTheAccountCard(): Promise<ReturnType<typeof createHostedSyncSettings>> {
    stepIs('ready');
    const hosted = createHostedSyncSettings();
    await hosted.load();
    expect(hosted.screen).toBe('account');
    return hosted;
  }

  it('opens the new-password screen without asking Rust anything', async () => {
    const hosted = await onTheAccountCard();
    rust.hostedCurrentStep.mockClear();

    hosted.beginChangeVaultPassword();

    expect(hosted.screen).toBe('changeVaultPassword');
    expect(rust.hostedCurrentStep).not.toHaveBeenCalled();
  });

  it('sends only the new password and lands back on the account card', async () => {
    const hosted = await onTheAccountCard();
    hosted.beginChangeVaultPassword();

    await hosted.changeVaultPassword('Tr0ubadour&Horse!');

    expect(rust.changeVaultPassword).toHaveBeenCalledWith('Tr0ubadour&Horse!');
    expect(rust.changeVaultPassword).toHaveBeenCalledTimes(1);
    expect(hosted.screen).toBe('account');
    expect(hosted.error).toBe('');
    expect(showGlobalToast).toHaveBeenCalledWith({
      path: 'sync.hosted.vaultPassword.change.changed',
    });
  });

  it('leaves the screen up with a retry sentence when another device won the race', async () => {
    const hosted = await onTheAccountCard();
    hosted.beginChangeVaultPassword();
    rust.changeVaultPassword.mockRejectedValueOnce({ kind: 'vaultKeyChangedElsewhere' });

    await hosted.changeVaultPassword('Tr0ubadour&Horse!');

    expect(hosted.screen).toBe('changeVaultPassword');
    expect(hosted.error).toContain('changed on another device');

    // The same press again: nothing else to do, and no re-read to ask for.
    await hosted.changeVaultPassword('Tr0ubadour&Horse!');
    expect(hosted.screen).toBe('account');
    expect(hosted.error).toBe('');
  });

  it('backs out of the new-password screen without changing anything', async () => {
    const hosted = await onTheAccountCard();
    hosted.beginChangeVaultPassword();

    await hosted.backToAccount();

    expect(hosted.screen).toBe('account');
    expect(rust.changeVaultPassword).not.toHaveBeenCalled();
  });

  it('shows a new recovery key on the wizard’s own save screen, marked as a replacement', async () => {
    const hosted = await onTheAccountCard();

    await hosted.newRecoveryKey();

    expect(hosted.screen).toBe('recoveryKey');
    expect(hosted.recoveryKey).toBe('ZYXW-VTSR-QPNM-KJHG-FEDC-BA98-7654');
    expect(hosted.recoveryKeyReplaced).toBe(true);
    expect(hosted.recoveryKeySaved).toBe(false);
  });

  it('forgets the replacement key the moment Continue is pressed', async () => {
    const hosted = await onTheAccountCard();
    await hosted.newRecoveryKey();

    await hosted.continueAfterRecoveryKey();

    expect(hosted.recoveryKey).toBeNull();
    expect(hosted.recoveryKeyReplaced).toBe(false);
    expect(hosted.screen).toBe('account');
    // Rust keeps no copy either, so there is nothing to ask twice for.
    expect(rust.newRecoveryKey).toHaveBeenCalledTimes(1);
  });

  it('reports a refused re-wrap as a sentence rather than losing the screen', async () => {
    const hosted = await onTheAccountCard();
    rust.newRecoveryKey.mockRejectedValueOnce({ kind: 'vaultLocked' });

    await hosted.newRecoveryKey();

    expect(hosted.screen).toBe('account');
    expect(hosted.recoveryKey).toBeNull();
    expect(hosted.error).toContain("doesn't have the vault key");
  });
});

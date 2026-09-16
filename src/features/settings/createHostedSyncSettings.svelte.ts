import {
  awaitHostedEntitled,
  awaitHostedSignIn,
  awaitPairing,
  beginHostedCheckout,
  beginHostedSignIn,
  beginPairing,
  cancelHostedWait,
  changeVaultPassword,
  createHostedVault,
  hostedBillingPortal,
  hostedBillingStatus,
  hostedCurrentStep,
  hostedServerUrl,
  hostedSession,
  hostedSignOut,
  minVaultPasswordLength,
  newRecoveryKey,
  probeSignInFlow,
  saveTextFile,
  unlockWithRecoveryKey,
  unlockWithVaultPassword,
  type BillingStatusOutput,
  type SetupStepOutput,
} from '$lib/platform/tauri';
import { getPlatformFS } from '$lib/platform';
import { openExternalUrl } from '$lib/platform/openExternalUrl';
import { requestSync } from '$features/sync/autoSync';
import { hostedBanner, type HostedBanner } from '$features/sync/hostedBanner';
import { currentWriteRefusal } from '$features/sync/hostedWriteRefusal.svelte';
import { hostedErrorMessage, hostedErrorVariant } from '$features/sync/hostedSyncErrors';
import { connectHostedE2ee, forgetHostedE2ee } from '$features/sync/syncServiceE2ee';
import { confirmDialog } from '$shared/dialogs/confirmDialog';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
import {
  localizedText,
  resolveLocalizedMessage,
  type LocalizedMessage,
} from '$shared/localization';

/**
 * Which hosted screen to render.
 *
 * Five of these are Rust's `SetupStep` verbatim. `recoveryKey` is not a step
 * and deliberately has no Rust variant: it exists only for as long as this
 * object holds the string `createVault` — or, from the account card,
 * `newRecoveryKey` — handed back, and Rust keeps no copy to hand over twice
 * (ADR 0003, decision 3). `changeVaultPassword` is the account card's other
 * detour and is likewise not a step: the wizard is finished and Rust answers
 * `ready` throughout. `loading` and `unavailable` are this shell's own — the
 * moment before Rust has answered, and a server that does not offer hosted
 * sync at all.
 */
export type HostedScreen =
  | 'loading'
  | 'unavailable'
  | 'signIn'
  | 'subscribe'
  | 'createVault'
  | 'recoveryKey'
  | 'unlock'
  | 'account'
  | 'changeVaultPassword';

/** What the sync section says when the server would refuse a write.
    The rule itself lives in `hostedBanner.ts`, shared with the test hook. */
export type { HostedBanner };

/** The three doors on the unlock screen. */
export type UnlockDoor = 'vaultPassword' | 'scan' | 'recoveryKey';

/**
 * What the scan door is doing. Desktop only ever **shows** a code; the phone
 * does the scanning (ADR 0003, decision 5).
 *
 * `expired` is the one that needs reading carefully. The relay carries no
 * "declined" signal — a person who says no on their phone sends nothing at all
 * — so a decline and a walk-away reach this screen identically, as the code's
 * five minutes running out. `refused` is narrower and rarer: the relay would
 * not serve the pairing (already answered, or not this account's).
 */
export type PairingState = 'idle' | 'waiting' | 'received' | 'expired' | 'refused';

/** What a browser window is currently open for. */
export type HostedWait = 'signIn' | 'checkout' | null;

/** The file a person saves their recovery key into. */
const RECOVERY_KEY_FILENAME = 'futo-notes-recovery-key.txt';

/** Rust's step, rendered. One entry per variant, so a new step cannot be
    silently swallowed by a fallback branch. */
const SCREEN_FOR_STEP: Record<SetupStepOutput['kind'], HostedScreen> = {
  signIn: 'signIn',
  subscribe: 'subscribe',
  createVault: 'createVault',
  unlock: 'unlock',
  ready: 'account',
};

/**
 * Everything the hosted sync section renders from, and everything it can do.
 *
 * Declared as an interface rather than left implicit so the section's prop is
 * structural: a test drives every screen and every banner by handing it a
 * plain object, with no Tauri and no state machine behind it.
 */
export interface HostedSyncSettings {
  readonly screen: HostedScreen;
  readonly busy: boolean;
  readonly waiting: HostedWait;
  readonly error: string;
  readonly serverUrl: string;
  readonly email: string;
  readonly billing: BillingStatusOutput | null;
  readonly banner: HostedBanner;
  /** Non-null only while the save-it-now screen is up. */
  readonly recoveryKey: string | null;
  /** True when the key on that screen replaced one a person already had. */
  readonly recoveryKeyReplaced: boolean;
  readonly minVaultPasswordLength: number;
  recoveryKeySaved: boolean;
  unlockDoor: UnlockDoor;
  selfHostedOpen: boolean;
  /** What the scan door is doing right now. */
  readonly pairing: PairingState;
  /** The string to draw as a QR code, straight from Rust. Non-null only
      while a live code is on screen. */
  readonly pairingPayload: string | null;
  /** RFC 3339, the relay's own deadline — what the countdown counts to. */
  readonly pairingExpiresAt: string | null;

  load(): Promise<void>;
  signIn(): Promise<void>;
  cancelWaiting(): Promise<void>;
  subscribe(): Promise<void>;
  createVault(vaultPassword: string): Promise<void>;
  copyRecoveryKey(): Promise<void>;
  saveRecoveryKeyToFile(): Promise<void>;
  continueAfterRecoveryKey(): Promise<void>;
  unlockWithPassword(vaultPassword: string): Promise<void>;
  unlockWithRecoveryKey(typed: string): Promise<void>;
  showPairingCode(): Promise<void>;
  cancelPairing(): Promise<void>;
  manageSubscription(): Promise<void>;
  beginChangeVaultPassword(): void;
  changeVaultPassword(newPassword: string): Promise<void>;
  newRecoveryKey(): Promise<void>;
  backToAccount(): Promise<void>;
  signOut(): Promise<void>;
}

class HostedSyncSettingsState implements HostedSyncSettings {
  screen = $state<HostedScreen>('loading');
  busy = $state(false);
  waiting = $state<HostedWait>(null);
  /** Where sign-in will happen, so a debug override is never invisible. */
  serverUrl = $state('');
  billing = $state<BillingStatusOutput | null>(null);
  minVaultPasswordLength = $state(12);
  recoveryKeySaved = $state(false);
  unlockDoor = $state<UnlockDoor>('vaultPassword');
  selfHostedOpen = $state(false);

  // The recovery key is the one value here that must not outlive its screen:
  // nothing persists it, nothing else reads it, and `continueAfterRecoveryKey`
  // is the only thing that clears it. Rust hands it over once and keeps no
  // copy, so once this is null there is no way to show it again.
  #recoveryKey = $state<string | null>(null);
  #recoveryKeyReplaced = $state(false);
  #email = $state('');
  #error = $state<LocalizedMessage | null>(null);

  #pairing = $state<PairingState>('idle');
  #pairingPayload = $state<string | null>(null);
  #pairingExpiresAt = $state<string | null>(null);

  // The first sync runs once per arrival at a set-up, unlocked vault — not
  // once per `current_step` read, which happens several times per wizard.
  // Signing out clears it, because signing back in is a new arrival.
  #startedSyncing = false;

  get recoveryKey(): string | null {
    return this.#recoveryKey;
  }

  get recoveryKeyReplaced(): boolean {
    return this.#recoveryKeyReplaced;
  }

  get pairing(): PairingState {
    return this.#pairing;
  }

  get pairingPayload(): string | null {
    return this.#pairingPayload;
  }

  get pairingExpiresAt(): string | null {
    return this.#pairingExpiresAt;
  }

  get email(): string {
    return this.#email;
  }

  get error(): string {
    return this.#error ? resolveLocalizedMessage(this.#error) : '';
  }

  get banner(): HostedBanner {
    // Two inputs, both live: the billing reading this screen took when it
    // opened, and the last cycle's own refusal — which arrives the moment a
    // refused cycle ends, whether or not anyone was looking at Settings.
    return hostedBanner(this.billing, this.screen === 'account', currentWriteRefusal());
  }

  async load(): Promise<void> {
    await this.#step(async () => {
      this.serverUrl = await hostedServerUrl();
      const flow = await probeSignInFlow(this.serverUrl);
      if (flow.kind !== 'hosted') {
        // An old deployment, or the hosted name not pointed at one yet. Saying
        // so beats opening a browser onto a route that is not there.
        this.screen = 'unavailable';
        return;
      }
      this.minVaultPasswordLength = await minVaultPasswordLength();
      await this.#readStep();
    });
  }

  async signIn(): Promise<void> {
    await this.#step(async () => {
      const handoff = await beginHostedSignIn();
      openExternalUrl(handoff.url);
      this.waiting = 'signIn';
      const outcome = await awaitHostedSignIn(handoff);
      this.waiting = null;
      if (outcome.kind === 'cancelled') return; // No error and no half state.
      if (outcome.kind === 'expired') {
        this.#error = { path: 'sync.hosted.errors.signInExpired' };
        return;
      }
      await this.#readStep();
    });
  }

  async cancelWaiting(): Promise<void> {
    await cancelHostedWait();
    this.waiting = null;
  }

  async subscribe(): Promise<void> {
    await this.#step(async () => {
      const checkout = await beginHostedCheckout();
      if (checkout.kind === 'alreadyEntitled') {
        await this.#readStep();
        return;
      }
      openExternalUrl(checkout.url);
      this.waiting = 'checkout';
      const outcome = await awaitHostedEntitled();
      this.waiting = null;
      if (outcome.kind === 'cancelled') return;
      if (outcome.kind === 'gaveUp') {
        this.billing = outcome.status;
        this.#error = { path: 'sync.hosted.errors.checkoutGaveUp' };
        return;
      }
      await this.#readStep();
    });
  }

  async createVault(vaultPassword: string): Promise<void> {
    await this.#step(async () => {
      this.#recoveryKey = await createHostedVault(vaultPassword);
      this.#recoveryKeyReplaced = false;
      this.recoveryKeySaved = false;
      this.screen = 'recoveryKey';
    });
  }

  async copyRecoveryKey(): Promise<void> {
    const key = this.#recoveryKey;
    if (!key) return;
    await this.#step(async () => {
      await (await getPlatformFS()).writeClipboardText(key);
      showGlobalToast({ path: 'sync.hosted.recoveryKey.copied' });
    });
  }

  async saveRecoveryKeyToFile(): Promise<void> {
    const key = this.#recoveryKey;
    if (!key) return;
    await this.#step(async () => {
      // The key alone, so the saved file pastes straight back into the unlock
      // field. The filename carries the explanation instead.
      const written = await saveTextFile({
        suggestedName: RECOVERY_KEY_FILENAME,
        filterName: localizedText('sync.hosted.recoveryKey.fileFilterName'),
        extensions: ['txt'],
        contents: `${key}\n`,
      });
      if (written) showGlobalToast({ path: 'sync.hosted.recoveryKey.saved' });
    });
  }

  async continueAfterRecoveryKey(): Promise<void> {
    this.#recoveryKey = null;
    this.#recoveryKeyReplaced = false;
    this.recoveryKeySaved = false;
    await this.#step(() => this.#readStep());
  }

  async unlockWithPassword(vaultPassword: string): Promise<void> {
    await this.#step(async () => {
      await unlockWithVaultPassword(vaultPassword);
      await this.#readStep();
    });
  }

  async unlockWithRecoveryKey(typed: string): Promise<void> {
    await this.#step(async () => {
      await unlockWithRecoveryKey(typed);
      await this.#readStep();
    });
  }

  /**
   * Opens a pairing and shows its code until the other device answers.
   *
   * One call covers the whole wait: Rust mints the one-time keypair, publishes
   * the public half to the relay, and polls for the sealed vault key until the
   * relay's own five minutes are up. What comes back decides the state, which
   * is why nothing here has its own timer — the countdown on screen only
   * describes this deadline, it does not enforce it.
   */
  async showPairingCode(): Promise<void> {
    await this.#step(async () => {
      this.#pairing = 'idle';
      this.#pairingPayload = null;
      const code = await beginPairing();
      this.#pairingPayload = code.payload;
      this.#pairingExpiresAt = code.expiresAt;
      this.#pairing = 'waiting';
      try {
        const outcome = await awaitPairing();
        this.#pairingPayload = null;
        if (outcome.kind === 'cancelled') {
          this.#pairing = 'idle';
          return;
        }
        // The key arrived and is kept: this device is unlocked. Said here
        // rather than after the step read, so the code's disappearance is
        // explained while that read is in flight.
        this.#pairing = 'received';
        await this.#readStep();
      } catch (cause) {
        this.#pairingPayload = null;
        const kind = hostedErrorVariant(cause)?.kind;
        // A person who declined on their phone sent nothing, so this is also
        // what declining looks like from here. The copy says so rather than
        // claiming to know which happened.
        if (kind === 'pairingExpired') {
          this.#pairing = 'expired';
          return;
        }
        if (kind === 'pairingRefused' || kind === 'pairingAlreadyKeyed') {
          this.#pairing = 'refused';
          return;
        }
        this.#pairing = 'idle';
        throw cause;
      }
    });
  }

  /**
   * Stops waiting and puts the three doors back. The code itself stays live on
   * the relay until it ages out — there is no way to withdraw one — so showing
   * a code again mints a new one rather than resuming this.
   */
  async cancelPairing(): Promise<void> {
    if (this.#pairing === 'waiting') await cancelHostedWait();
    this.#pairing = 'idle';
    this.#pairingPayload = null;
    this.#pairingExpiresAt = null;
  }

  /**
   * Opens the new-password screen. No round trip and no current secret asked:
   * this device holds the vault key already, and a device paired by QR never
   * knew the old password (ADR 0003, decision 10).
   */
  beginChangeVaultPassword(): void {
    this.screen = 'changeVaultPassword';
  }

  /**
   * Re-wraps the password envelope and goes back to the account card.
   *
   * Rust re-wraps the same vault key, so every other device carries on with
   * what it already holds and is never told anything happened (parent spec
   * user story 33). A `vaultKeyChangedElsewhere` rejection leaves the screen
   * where it is with that sentence on it, because pressing the button again
   * is the whole remedy.
   */
  async changeVaultPassword(newPassword: string): Promise<void> {
    await this.#step(async () => {
      await changeVaultPassword(newPassword);
      showGlobalToast({ path: 'sync.hosted.vaultPassword.change.changed' });
      await this.#readStep();
    });
  }

  /**
   * Issues a new recovery key and shows it on the same save screen the wizard
   * uses — the old one has stopped working by the time it appears.
   */
  async newRecoveryKey(): Promise<void> {
    await this.#step(async () => {
      this.#recoveryKey = await newRecoveryKey();
      this.#recoveryKeyReplaced = true;
      this.recoveryKeySaved = false;
      this.screen = 'recoveryKey';
    });
  }

  /** Leaves an account-card detour without doing anything. */
  async backToAccount(): Promise<void> {
    await this.#step(() => this.#readStep());
  }

  async manageSubscription(): Promise<void> {
    await this.#step(async () => {
      openExternalUrl(await hostedBillingPortal());
    });
  }

  async signOut(): Promise<void> {
    const confirmed = await confirmDialog(localizedText('sync.hosted.signOut.confirmationBody'), {
      title: localizedText('sync.hosted.signOut.confirmationTitle'),
      kind: 'warning',
    });
    if (!confirmed) return;
    await this.#step(async () => {
      await hostedSignOut();
      forgetHostedE2ee();
      this.#recoveryKey = null;
      this.#recoveryKeyReplaced = false;
      this.#startedSyncing = false;
      this.#pairing = 'idle';
      this.#pairingPayload = null;
      this.#pairingExpiresAt = null;
      await this.#readStep();
    });
  }

  /**
   * Asks Rust which screen we are on, and reads what that screen needs.
   *
   * This is the ONLY thing that decides the wizard's position. Nothing here
   * remembers a step, which is what makes quitting halfway and reopening land
   * on the right screen rather than on a saved cursor that can disagree with
   * the server (ADR 0003, decision 3).
   */
  async #readStep(): Promise<void> {
    const current = await hostedCurrentStep();
    if (current.kind === 'signIn') {
      this.#email = '';
      this.billing = null;
      this.screen = 'signIn';
      return;
    }
    this.screen = SCREEN_FOR_STEP[current.kind];
    const who = await hostedSession();
    this.#email = who?.email ?? '';
    this.billing = await hostedBillingStatus();
    if (current.kind === 'ready') await this.#startSyncing();
  }

  /**
   * Turns a set-up, unlocked vault into a running sync.
   *
   * This is the end of the wizard doing what the wizard is for: Rust hands the
   * vault key and the session token it already holds to the sync engine, and
   * then the ordinary sync path runs a cycle — the same `requestSync` a
   * self-hosted connect and every later auto-sync go through, not a second
   * one written for hosted.
   *
   * Once per arrival. A failure puts that back, so reopening this screen tries
   * again rather than leaving a set-up vault that never syncs.
   */
  async #startSyncing(): Promise<void> {
    if (this.#startedSyncing) return;
    this.#startedSyncing = true;
    try {
      await connectHostedE2ee();
      await requestSync();
    } catch (cause) {
      this.#startedSyncing = false;
      throw cause;
    }
  }

  /**
   * Runs one step, reporting whatever it fails with as a sentence. Nothing
   * else here catches, so no failure can leave the section busy forever.
   */
  async #step(work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.#error = null;
    try {
      await work();
    } catch (cause) {
      console.warn('[hosted] step failed', cause);
      this.#error = hostedErrorMessage(cause);
    } finally {
      this.busy = false;
      this.waiting = null;
    }
  }
}

export function createHostedSyncSettings(): HostedSyncSettings {
  return new HostedSyncSettingsState();
}

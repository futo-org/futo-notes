import {
  awaitHostedEntitled,
  awaitHostedSignIn,
  beginHostedCheckout,
  beginHostedSignIn,
  cancelHostedWait,
  createHostedVault,
  hostedBillingPortal,
  hostedBillingStatus,
  hostedCurrentStep,
  hostedServerUrl,
  hostedSession,
  hostedSignOut,
  minVaultPasswordLength,
  probeSignInFlow,
  saveTextFile,
  unlockWithRecoveryKey,
  unlockWithVaultPassword,
  type BillingStatusOutput,
  type SetupStepOutput,
} from '$lib/platform/tauri';
import { getPlatformFS } from '$lib/platform';
import { openExternalUrl } from '$lib/platform/openExternalUrl';
import { hostedErrorMessage } from '$features/sync/hostedSyncErrors';
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
 * object holds the string `createVault` handed back, which happens exactly
 * once per vault because a second create is refused (ADR 0003, decision 3).
 * `loading` and `unavailable` are this shell's own — the moment before Rust
 * has answered, and a server that does not offer hosted sync at all.
 */
export type HostedScreen =
  | 'loading'
  | 'unavailable'
  | 'signIn'
  | 'subscribe'
  | 'createVault'
  | 'recoveryKey'
  | 'unlock'
  | 'account';

/** What the sync section says when the server would refuse a write. */
export type HostedBanner = 'none' | 'syncPaused' | 'vaultFull';

/** The three doors on the unlock screen. */
export type UnlockDoor = 'vaultPassword' | 'scan' | 'recoveryKey';

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
  readonly minVaultPasswordLength: number;
  recoveryKeySaved: boolean;
  unlockDoor: UnlockDoor;
  selfHostedOpen: boolean;

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
  manageSubscription(): Promise<void>;
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
  #email = $state('');
  #error = $state<LocalizedMessage | null>(null);

  get recoveryKey(): string | null {
    return this.#recoveryKey;
  }

  get email(): string {
    return this.#email;
  }

  get error(): string {
    return this.#error ? resolveLocalizedMessage(this.#error) : '';
  }

  /**
   * A banner is a fact about the account, read the same way the account card
   * reads everything else. Sync paused wins over a full vault: a lapsed
   * subscription refuses the write whatever the quota says, so telling someone
   * to buy more storage would be the wrong instruction.
   */
  get banner(): HostedBanner {
    const billing = this.billing;
    if (this.screen !== 'account' || !billing) return 'none';
    if (!billing.entitled) return 'syncPaused';
    if (billing.storageQuotaBytes > 0 && billing.bytesUsed >= billing.storageQuotaBytes) {
      return 'vaultFull';
    }
    return 'none';
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

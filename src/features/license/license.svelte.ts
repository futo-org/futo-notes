// Reactive license state for the desktop shell.
//
// Read once at bootstrap and updated from the result of each action — never
// re-verified per render and never per keystroke (M5). Every action returns the
// new state together with its outcome, so nothing here has to ask again.

import {
  clearLicense,
  subscribeLicenseLinks,
  readLicenseLinks,
  readLicenseStatus,
  submitLicenseKey,
  takePendingLicenseLink,
  UNLICENSED,
  type LicenseLinks,
  type LicenseOutcome,
  type LicenseView,
} from '$lib/platform/license';
import { openExternalUrl } from '$lib/platform/openExternalUrl';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';

/// One outcome, one message. A key the server does not know and a pair that
/// does not verify deliberately share "isn't valid" — the user is never told
/// which (docs/spec/license.md § Entering a key).
const ENTRY_TOASTS: Readonly<Record<LicenseOutcome, string>> = {
  activated: 'license.activated',
  invalid: 'license.keyInvalid',
  offline: 'license.offline',
};

/// A link that fails says so as a *link*, because the user never typed a key.
const LINK_TOASTS: Readonly<Record<LicenseOutcome, string>> = {
  activated: 'license.activated',
  invalid: 'license.linkInvalid',
  offline: 'license.linkInvalid',
};

class LicenseModel {
  view = $state<LicenseView>(UNLICENSED);
  links = $state<LicenseLinks>({ buy: '', support: '' });
  /// True only while the one activation request is in flight.
  busy = $state(false);
  /// Counts the moments this device *became* licensed, so a surface showing
  /// the supporter coin can mark the occasion. Deliberately driven from
  /// `#replaceView` and not from the startup read: launching an app that was
  /// already licensed is not an activation, and should not set anything off.
  activations = $state(0);

  #started = false;
  #stateRevision = 0;

  /// Starts license state. Deliberately returns nothing to await: a license
  /// read must never delay the shell's first paint (M1).
  start(): () => void {
    if (this.#started) return () => {};
    this.#started = true;

    void this.#refresh(this.#stateRevision);
    void readLicenseLinks()
      .then((links) => {
        this.links = links;
      })
      .catch((error) => console.warn('Failed to read the license links:', error));

    // Rust parks every link outcome and nudges; draining is the only way to read
    // one, so a link is reported exactly once whether it arrived before the shell
    // existed (cold start) or while it was running.
    //
    // The order matters and has to be *awaited*: the listener must be attached
    // before the first drain, or a link landing in between is reported by
    // neither and waits in the inbox until the next launch.
    let unsubscribe: (() => void) | null = null;
    let stopped = false;
    void (async () => {
      try {
        const stop = await subscribeLicenseLinks(() => void this.#drainLink());
        if (stopped) stop();
        else unsubscribe = stop;
        await this.#drainLink();
      } catch (error) {
        console.warn('Failed to subscribe to license links:', error);
      }
    })();

    return () => {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      // Restartable: a remount must re-read the license rather than silently
      // keep whatever this instance last saw.
      this.#started = false;
      this.#stateRevision += 1;
    };
  }

  async #refresh(startingRevision: number): Promise<void> {
    try {
      const view = await readLicenseStatus();
      if (startingRevision === this.#stateRevision) this.view = view;
    } catch (error) {
      console.warn('Failed to read the license status:', error);
    }
  }

  async #drainLink(): Promise<void> {
    try {
      const result = await takePendingLicenseLink();
      if (!result) return;
      this.#replaceView(result.view);
      showGlobalToast({ path: LINK_TOASTS[result.outcome] });
    } catch (error) {
      console.warn('Failed to read a pending license link:', error);
    }
  }

  /// Recognise, activate if needed, verify and store — one Rust call.
  /// Answers whether the license was accepted, so the field can close itself.
  async enterKey(input: string): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const result = await submitLicenseKey(input);
      this.#replaceView(result.view);
      showGlobalToast({ path: ENTRY_TOASTS[result.outcome] });
      return result.outcome === 'activated';
    } catch (error) {
      console.error('Failed to enter a license key:', error);
      showGlobalToast({ path: 'license.keyInvalid' });
      return false;
    } finally {
      this.busy = false;
    }
  }

  async remove(): Promise<void> {
    try {
      this.#replaceView(await clearLicense());
    } catch (error) {
      console.error('Failed to remove the license:', error);
    }
  }

  /// Buy and Renew are the same destination. It opens in the SYSTEM browser,
  /// never a webview, and the URL comes from Rust so no shell hardcodes it.
  openBuyPage(): void {
    if (this.links.buy) openExternalUrl(this.links.buy);
  }

  openSupport(): void {
    if (this.links.support) openExternalUrl(this.links.support);
  }

  #replaceView(view: LicenseView): void {
    this.#stateRevision += 1;
    // Only the crossing counts. Re-entering a key you already hold leaves the
    // state at licensed and is not a second activation.
    if (view.state === 'licensed' && this.view.state !== 'licensed') this.activations += 1;
    this.view = view;
  }
}

export const license = new LicenseModel();

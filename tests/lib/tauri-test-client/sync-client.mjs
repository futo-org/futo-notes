/**
 * The Tauri test client's sync operations: password sync, hosted sync and pairing.
 */

import { sleep } from '../mcp-client.mjs';
import { visitAsBrowser } from '../standin-browser.mjs';
import { TauriNotesClient } from './notes-client.mjs';

export class TauriSyncClient extends TauriNotesClient {
  async startSync() {
    this._startedSyncSlotRef = this._nextAsyncSlotRef('startedSync');
    await this._kickOffSync(this._startedSyncSlotRef);
  }

  async awaitStartedSync({ timeoutMs = 180_000 } = {}) {
    if (!this._startedSyncSlotRef) throw new Error(`${this.name}: startSync was not called`);
    return this._awaitSyncSlot(this._startedSyncSlotRef, timeoutMs);
  }

  // ── Hosted sync (Log in with FUTO) ────────────────────────────
  //
  // Every call here forwards one `window.__testSync` hosted hook. The one that
  // needs explaining is connectHosted: the app waits on a sign-in and a
  // checkout that a person finishes IN A BROWSER, so this process has to be
  // that browser. The app publishes the URL it would have opened, this visits
  // it with a cookie jar, and the app's own poll then completes — nothing here
  // reaches past the wait or fakes its outcome.

  /** Runs the hosted wizard to a first sync, acting as the browser. */
  async connectHosted(options, { timeoutMs = 180_000 } = {}) {
    // No trailing slash: the engine trims one anyway, and a scenario that
    // prints the address should print the one the app was told.
    const serverUrl = this.normalizeServerUrl(options.serverUrl).replace(/\/$/, '');
    const slotRef = this._nextAsyncSlotRef('connectHosted');
    await this._kickOffAsync(
      slotRef,
      `window.__testSync.connectHosted(${JSON.stringify({ ...options, serverUrl })})`,
    );
    return this._awaitSlotActingAsBrowser(slotRef, timeoutMs, 'connectHosted');
  }

  async hostedProgress() {
    return this._executeRead(`window.__testSync.hostedProgress()`, 'hostedProgress');
  }

  async hostedAccount() {
    return this._executeMutation(`window.__testSync.hostedAccount()`, 'hostedAccount');
  }

  async hostedSessionToken() {
    return this._executeMutation(`window.__testSync.hostedSessionToken()`, 'hostedSessionToken');
  }

  /**
   * The banner the LAST completed cycle earned on its own — no billing call,
   * no account screen. hostedAccount() re-reads `billing_status` every time,
   * so it can never tell a banner earned by a refused write apart from one
   * earned by the reading it just took; this can.
   */
  async hostedRefusalBanner() {
    return this._executeRead(`window.__testSync.hostedRefusalBanner()`, 'hostedRefusalBanner');
  }

  /**
   * Starts showing a pairing code, on the device being set up. Long-running by
   * design — it holds the relay's whole five-minute window — so the code is
   * read with waitForPairingPayload() and the outcome awaited separately.
   */
  async startShowPairingCode() {
    this._pairingSlotRef = this._nextAsyncSlotRef('showPairingCode');
    await this._kickOffAsync(this._pairingSlotRef, `window.__testSync.showPairingCode()`);
  }

  /** The payload string a camera would have read off this client's screen. */
  async waitForPairingPayload(timeoutMs = 30_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const progress = await this.hostedProgress();
      if (progress?.pairingPayload) return progress.pairingPayload;
      await sleep(100);
    }
    throw new Error(`${this.name}: no pairing code appeared within ${timeoutMs}ms`);
  }

  async awaitShowPairingCode({ timeoutMs = 180_000 } = {}) {
    if (!this._pairingSlotRef) throw new Error(`${this.name}: startShowPairingCode was not called`);
    return this._awaitAsyncSlot(this._pairingSlotRef, timeoutMs, 'showPairingCode');
  }

  /** The scanning half, on the already-unlocked device. */
  async acceptPairing(scanned, { timeoutMs = 60_000 } = {}) {
    return this._executeMutation(
      `window.__testSync.acceptPairing(${JSON.stringify(scanned)})`,
      'acceptPairing',
      { timeoutMs },
    );
  }

  async hostedSignOut() {
    return this._executeMutation(`window.__testSync.hostedSignOut()`, 'hostedSignOut');
  }

  /** Drops this device's hosted secrets, so the next scenario starts fresh. */
  async forgetHosted() {
    return this._executeMutation(`window.__testSync.forgetHosted()`, 'forgetHosted');
  }

  /**
   * Awaits an async slot while acting as the browser for whatever it opens.
   *
   * A URL is visited exactly once: `opened` grows as the flow moves from
   * sign-in to checkout, and re-fetching a spent hand-off would be a second
   * login rather than a no-op.
   */
  async _awaitSlotActingAsBrowser(slotRef, timeoutMs, label) {
    const visited = new Set();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this._executeRead(
        `window[${JSON.stringify(slotRef)}]`,
        `${label} status`,
      );
      if (status?.done) {
        if (status.error) throw new Error(`${label} failed: ${status.error}`);
        return status.value;
      }
      const progress = await this.hostedProgress();
      const url = progress?.openUrl;
      if (url && !visited.has(url)) {
        visited.add(url);
        await visitAsBrowser(url);
      }
      await sleep(100);
    }
    throw new Error(`${this.name}: ${label} did not complete within ${timeoutMs}ms`);
  }

  async connectSync(serverUrl, password, { timeoutMs = 180_000 } = {}) {
    return this._executeMutation(
      `window.__testSync.connect(${JSON.stringify(this.normalizeServerUrl(serverUrl))}, ${JSON.stringify(password)})`,
      'connectSync',
      { timeoutMs },
    );
  }

  async syncNow({ timeoutMs = 180_000 } = {}) {
    return this._executeMutation('window.__testSync.syncNow()', 'syncNow', { timeoutMs });
  }

  async disconnectSync() {
    return this._executeMutation(`window.__testSync.disconnect()`, 'disconnectSync');
  }

  async syncStatus() {
    return this._executeRead(`window.__testSync.status()`, 'syncStatus');
  }

  async pauseAutoSync() {
    return this._executeMutation(`window.__testSync.pauseAutoSync()`, 'pauseAutoSync');
  }

  async resumeAutoSync() {
    return this._executeMutation(`window.__testSync.resumeAutoSync()`, 'resumeAutoSync');
  }
}

/**
 * The Tauri test client's connection to the app: the MCP bridge calls with their
 * timeout retries, guarded async slots, and condition polling.
 */

import { URL } from 'node:url';
import { executeJs, sleep } from '../mcp-client.mjs';

export const SCRIPT_EXECUTION_TIMEOUT = 'Script execution timeout';
export const MAIN_WINDOW_NOT_FOUND = "Window 'main' not found";
const EXECUTE_JS_RETRY_ATTEMPTS = 3;

/**
 * Point a host-loopback server URL at the address a non-host client uses to
 * reach the host (the Android emulator's 10.0.2.2). Shared with the native
 * Android client so both legs translate the harness server URL identically.
 */
export function rewriteLoopbackHost(serverUrl, host) {
  const url = new URL(serverUrl);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
    url.hostname = host;
  }
  return url.toString();
}

export class TauriBridgeClient {
  constructor({
    name,
    platform,
    ws,
    notesDir = null,
    dataDir = null,
    logFile = null,
    port = null,
    proc = null,
    stopProc = null,
    loopbackHost = '127.0.0.1',
  }) {
    this.name = name;
    this.platform = platform;
    this.ws = ws;
    this.notesDir = notesDir;
    this.dataDir = dataDir;
    this.logFile = logFile;
    this.port = port;
    this.proc = proc;
    this.stopProc = stopProc;
    this.loopbackHost = loopbackHost;
    this._asyncSlotCounter = 0;
    this._startedSyncSlotRef = null;
    this._pairingSlotRef = null;
    this.capabilities = {
      supportsHostExternalMutation: Boolean(notesDir),
    };
  }

  normalizeServerUrl(serverUrl) {
    return rewriteLoopbackHost(serverUrl, this.loopbackHost);
  }

  async readWebview(expression, label = 'webview read') {
    return this._executeRead(expression, label);
  }

  // The MCP bridge hard-caps every execute_js call at 5s. Reads can retry
  // directly, but a mutation timeout leaves its execution outcome unknown.
  // Stable guarded slots let kickoff retries poll the original result without
  // ever applying the mutation twice.

  _nextAsyncSlotRef(label) {
    this._asyncSlotCounter += 1;
    return `__crossPlatformSyncCall_${label}_${this._asyncSlotCounter}`;
  }

  async _executeWithBridgeTimeoutRetries(operation, label) {
    let lastError = null;
    for (let attempt = 1; attempt <= EXECUTE_JS_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (error.message !== SCRIPT_EXECUTION_TIMEOUT) throw error;
        lastError = error;
      }
    }
    throw new Error(
      `${this.name}: ${label} failed after ${EXECUTE_JS_RETRY_ATTEMPTS} bridge timeout attempts: ${lastError.message}`,
    );
  }

  async _executeRead(expression, label) {
    return this._executeWithBridgeTimeoutRetries(() => executeJs(this.ws, expression), label);
  }

  async _executeMutation(expression, label, { timeoutMs = 180_000 } = {}) {
    const slotRef = this._nextAsyncSlotRef(label);
    await this._kickOffAsync(slotRef, expression);
    return this._awaitAsyncSlot(slotRef, timeoutMs, label);
  }

  async _kickOffAsync(slotRef, expression) {
    const script = `(() => {
      const slot = ${JSON.stringify(slotRef)};
      if (!window[slot]) {
        window[slot] = { done: false };
        Promise.resolve(${expression}).then(
          (value) => { window[slot] = { done: true, value }; },
          (error) => { window[slot] = { done: true, error: String(error && error.message || error) }; },
        );
      }
      return 'started';
    })()`;

    await this._executeWithBridgeTimeoutRetries(
      () => executeJs(this.ws, script),
      `kickoff for ${slotRef}`,
    );
  }

  async _kickOffSync(slotRef) {
    await this._kickOffAsync(slotRef, 'window.__testSync.syncNow()');
  }

  async _awaitAsyncSlot(slotRef, timeoutMs, label) {
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
      await sleep(200);
    }
    throw new Error(`${this.name}: ${label} did not complete within ${timeoutMs}ms`);
  }

  async _awaitSyncSlot(slotRef, timeoutMs) {
    return this._awaitAsyncSlot(slotRef, timeoutMs, 'syncNow');
  }

  async waitForOpenNote(id, timeoutMs = 10_000) {
    return this.waitForCondition(
      `(() => {
      const state = window.__notesShellTest?.getState?.();
      return Boolean(state && state.originalId === ${JSON.stringify(id)});
    })()`,
      timeoutMs,
      `open note ${id}`,
    );
  }

  async waitForRoute(path, timeoutMs = 10_000) {
    return this.waitForCondition(`window.location.hash === '#${path}'`, timeoutMs, `route ${path}`);
  }

  async waitForEditorReady(timeoutMs = 10_000) {
    return this.waitForCondition(
      `(() => {
      return Boolean(document.querySelector('.futo-milkdown') && document.querySelector('.ProseMirror') && document.querySelector('.title-input'));
    })()`,
      timeoutMs,
      'editor ready',
    );
  }

  async waitForCondition(script, timeoutMs, label) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await this._executeRead(script, label);
      if (result) return;
      await sleep(100);
    }
    throw new Error(`${this.name}: timed out waiting for ${label}`);
  }
}

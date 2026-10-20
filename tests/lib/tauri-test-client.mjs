/**
 * Shared Tauri test client used by desktop and Android-backed harnesses.
 */

import { executeJs, sleep } from './mcp-client.mjs';
import {
  MAIN_WINDOW_NOT_FOUND,
  SCRIPT_EXECUTION_TIMEOUT,
} from './tauri-test-client/bridge-client.mjs';
import { TauriSyncClient } from './tauri-test-client/sync-client.mjs';

// Callers import the loopback rewrite from here, where it was declared.
export { rewriteLoopbackHost } from './tauri-test-client/bridge-client.mjs';

export async function waitForTestHooks(
  ws,
  name,
  { initialDelayMs = 3_000, attempts = 15, intervalMs = 2_000 } = {},
) {
  await sleep(initialDelayMs);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await executeJs(
        ws,
        `JSON.stringify({
        testSync: typeof window.__testSync,
        // The hosted half is installed with the rest of the hook, so its
        // absence means a bundle built before futo-notes#186 — not a hook
        // that is still coming up. Probed here so that shows up now, with
        // the "was it built with test hooks?" message, rather than six
        // scenarios later as "connectHosted is not a function".
        connectHosted: typeof window.__testSync?.connectHosted,
        notesShell: typeof window.__notesShellTest,
      })`,
      );
      const parsed = JSON.parse(String(result));
      if (
        parsed.testSync === 'object' &&
        parsed.connectHosted === 'function' &&
        parsed.notesShell === 'object'
      ) {
        return;
      }
      lastError = null;
    } catch (error) {
      // The bridge can accept WebSocket connections before the webview is
      // ready to run JS or before Tauri registers the main window.
      if (error.message !== SCRIPT_EXECUTION_TIMEOUT && error.message !== MAIN_WINDOW_NOT_FOUND) {
        throw error;
      }
      lastError = error;
    }
    await sleep(intervalMs);
  }

  const totalMs = initialDelayMs + attempts * intervalMs;
  const suffix = lastError ? ` Last probe error: ${lastError.message}` : '';
  throw new Error(
    `${name}: test hooks not available after ${Math.round(totalMs / 1000)}s. Was the frontend built with VITE_INCLUDE_TEST_HOOKS=true?${suffix}`,
  );
}

export class TauriTestClient extends TauriSyncClient {
  async reset() {
    // Before the password-mode disconnect: a hosted scenario leaves a vault key
    // and a session token in this device's secret store, keyed per notes root
    // and therefore surviving into the next scenario — which would then start
    // on a device that is already set up. A no-op on a client that has never
    // run one.
    try {
      await this.forgetHosted();
    } catch {
      /* hook may be missing, or nothing hosted ever ran here */
    }
    try {
      await this.disconnectSync();
    } catch {
      /* may not be connected */
    }
    try {
      await this.deleteAllNotes();
    } catch {
      /* may have no notes */
    }
    // A scenario may have paused auto-sync; restore default for the next one.
    try {
      await this.resumeAutoSync();
    } catch {
      /* hook may be missing */
    }
  }

  stop() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    try {
      this.stopProc?.();
    } catch {
      /* ignore */
    }
    try {
      this.proc?.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

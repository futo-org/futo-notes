/**
 * Shared Tauri test client used by desktop and Android-backed harnesses.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';
import { executeJs, sleep } from './mcp-client.mjs';
import { visitAsBrowser } from './standin-browser.mjs';

const SCRIPT_EXECUTION_TIMEOUT = 'Script execution timeout';
const MAIN_WINDOW_NOT_FOUND = "Window 'main' not found";
const EXECUTE_JS_RETRY_ATTEMPTS = 3;

// Typing a title the way a user does: focus the field, then fire `input` so the
// app's title handler runs (which arms the 10s title-save debounce). Shared so
// setTitle() and composeNoteAndSyncNow() drive the exact same page-side path.
function titleInputExpression(title) {
  return `(() => {
      const input = document.querySelector('.title-input');
      if (!(input instanceof HTMLTextAreaElement)) {
        throw new Error('title input not found');
      }
      input.focus();
      input.value = ${JSON.stringify(title)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`;
}

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

export class TauriTestClient {
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

  async externalWriteNote(id, content) {
    if (!this.capabilities.supportsHostExternalMutation || !this.notesDir) {
      throw new Error(
        `${this.name}: external host note mutation is not supported on ${this.platform}`,
      );
    }
    writeFileSync(join(this.notesDir, `${id}.md`), content);
  }

  async writeNote(id, content) {
    return this._executeMutation(
      `window.__testNotes.writeNote(${JSON.stringify(id)}, ${JSON.stringify(content)})`,
      'writeNote',
    );
  }

  async readNote(id) {
    return this._executeRead(`window.__testNotes.readNote(${JSON.stringify(id)})`, 'readNote');
  }

  async listNotes() {
    return this._executeRead(`window.__testNotes.listNoteFiles()`, 'listNotes');
  }

  async deleteNote(id) {
    return this._executeMutation(
      `window.__testNotes.deleteNoteFile(${JSON.stringify(id)})`,
      'deleteNote',
    );
  }

  // App-level delete: goes through the same path as a user delete, so the
  // notes cache is pruned synchronously. deleteNote() above is a raw FS
  // unlink for scenarios simulating EXTERNAL deletions — its watcher echo
  // can be suppressed when a sync pushes the tombstone first, leaving the
  // cache stale (which is correct to test for external edits, but races
  // when the scenario means "the user deleted a note in the app").
  async deleteNoteInApp(id) {
    return this._executeMutation(
      `window.__testNotes.deleteNote(${JSON.stringify(id)})`,
      'deleteNoteInApp',
    );
  }

  async deleteAllNotes() {
    return this._executeMutation(`window.__testNotes.deleteAllContent()`, 'deleteAllNotes');
  }

  async noteExists(id) {
    return this._executeRead(`window.__testNotes.noteExists(${JSON.stringify(id)})`, 'noteExists');
  }

  async listFolders() {
    return this._executeRead(`window.__testNotes.listFolders()`, 'listFolders');
  }

  async createFolder(path) {
    return this._executeMutation(
      `window.__testNotes.createFolder(${JSON.stringify(path)})`,
      'createFolder',
    );
  }

  async renameFolder(from, to) {
    return this._executeMutation(
      `window.__testNotes.renameFolder(${JSON.stringify(from)}, ${JSON.stringify(to)})`,
      'renameFolder',
    );
  }

  async deleteFolder(path) {
    return this._executeMutation(
      `window.__testNotes.deleteFolder(${JSON.stringify(path)})`,
      'deleteFolder',
    );
  }

  async moveNote(fromId, toId) {
    return this._executeMutation(
      `window.__testNotes.moveNote(${JSON.stringify(fromId)}, ${JSON.stringify(toId)})`,
      'moveNote',
    );
  }

  /** Like moveNote, but if the target ID already exists the incoming
   *  file is suffixed (`A/note` → `A/note-2`). Mirrors the UI-driven
   *  `moveNote` flow in `src/features/notes/notes.svelte.ts`. */
  async moveNoteWithCollisions(fromId, toId) {
    return this._executeMutation(
      `window.__testNotes.moveNoteWithCollisions(${JSON.stringify(fromId)}, ${JSON.stringify(toId)})`,
      'moveNoteWithCollisions',
    );
  }

  async openNewNote() {
    await this._executeMutation(`window.location.hash = '#/note/new'`, 'openNewNote');
    await this.waitForRoute('/note/new');
    await this.waitForEditorReady();
    // The route flip only STARTS the new-note load: the loader flushes any
    // pending save first, then seeds the fresh Untitled session. Returning
    // before that lands leaves the PREVIOUS note's title/originalId observable,
    // so a caller that types immediately edits (and can save) the wrong note.
    await this.waitForNewNoteSession();
  }

  async waitForNewNoteSession(timeoutMs = 10_000) {
    return this.waitForCondition(
      `(() => {
      const state = window.__notesShellTest?.getState?.();
      return Boolean(state && state.originalId === null && /^Untitled/.test(state.title));
    })()`,
      timeoutMs,
      'fresh new-note session',
    );
  }

  async openNote(id) {
    const encodedId = encodeURIComponent(id);
    await this._executeMutation(`window.location.hash = '#/note/${encodedId}'`, 'openNote');
    await this.waitForRoute(`/note/${encodedId}`);
    await this.waitForEditorReady();
    await this.waitForOpenNote(id);
  }

  async setTitle(title) {
    return this._executeMutation(titleInputExpression(title), 'setTitle');
  }

  async typeInEditor(text) {
    return this._executeMutation(
      `window.__notesShellTest.typeInEditor(${JSON.stringify(text)})`,
      'typeInEditor',
    );
  }

  // Compose a brand-new note in the editor and request a manual sync in the SAME
  // page task: type the body (arming the 500ms body debounce), then the title
  // (which replaces it with the 10s title debounce), then call syncNow().
  //
  // Nothing can save in between — JS is single-threaded, so no debounce timer,
  // blur flush or watcher callback runs until the syncNow() await yields. The
  // returned `preSync` snapshot is therefore EVIDENCE that the note was still
  // unsaved when the sync was requested, not a poll racing a millisecond-wide
  // window over the bridge. Only the sync's own flush can have persisted it.
  async composeNoteAndSyncNow(title, body, { timeoutMs = 180_000 } = {}) {
    return this._executeMutation(
      `(async () => {
      window.__notesShellTest.typeInEditor(${JSON.stringify(body)});
      ${titleInputExpression(title)};
      const before = window.__notesShellTest.getState();
      const preSync = {
        originalId: before.originalId,
        savePending: before.savePending,
        editorContent: before.editorContent,
        title: before.title,
      };
      const result = await window.__testSync.syncNow();
      return { preSync, summary: result.summary };
    })()`,
      'composeNoteAndSyncNow',
      { timeoutMs },
    );
  }

  async flushSave() {
    return this._executeMutation(`window.__notesShellTest.flushSave()`, 'flushSave');
  }

  // Deliver a single file-watcher event to the shell and await its handling.
  // The resolved promise is the observable "external change processed" signal,
  // so a test can drive the watcher aftermath of a sync deterministically
  // instead of sleeping for a fixed settle window.
  async deliverFileChange(type, filename) {
    return executeJs(
      this.ws,
      `window.__notesShellTest.handleFileChange({ type: ${JSON.stringify(type)}, filename: ${JSON.stringify(filename)} })`,
    );
  }

  async getOpenNoteState() {
    return this._executeRead(`window.__notesShellTest.getState()`, 'getOpenNoteState');
  }

  // Drive the shell's focus-change seam through its debug-only hook with a
  // SYNTHETIC focus signal. Real OS focus is not available here: CM6's `hasFocus`
  // consults `document.hasFocus()`, and a mesh runs two desktop windows at once,
  // of which at most one can hold focus — so the flag is the only way both
  // clients can play the focused role in a scenario. What the scenario then
  // asserts is real: `session.editorFocused` reads this flag, and the deferral,
  // blur-settle, and adopt decisions downstream of it are production code.
  //
  // Not asserted afterwards, deliberately: `setEditorFocused` is awaited and sets
  // the flag as its first statement, so a poll for `isEditorFocused()` could only
  // ever pass — and it did, by reading back the write, which is why the hook now
  // reports REAL editor focus instead. Real click-focus → `onfocuschange` →
  // `handleEditorFocusChange` is covered where a browser can actually focus a
  // window (tests/editor-focus-signal.spec.ts); the Android leg exercises the
  // whole chain with genuine device focus (focusOpenEditor).
  async focusEditor() {
    await this._executeMutation(`window.__notesShellTest.setEditorFocused(true)`, 'focusEditor');
  }

  // Drive the matching blur seam so deferred adoption settles before the
  // scenario reads the editor again.
  async blurEditor() {
    await this._executeMutation(`window.__notesShellTest.setEditorFocused(false)`, 'blurEditor');
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

  async startSync() {
    this._startedSyncSlotRef = this._nextAsyncSlotRef('startedSync');
    await this._kickOffSync(this._startedSyncSlotRef);
  }

  async awaitStartedSync({ timeoutMs = 180_000 } = {}) {
    if (!this._startedSyncSlotRef) throw new Error(`${this.name}: startSync was not called`);
    return this._awaitSyncSlot(this._startedSyncSlotRef, timeoutMs);
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
      return Boolean(document.querySelector('.cm-editor') && document.querySelector('.cm-content') && document.querySelector('.title-input'));
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

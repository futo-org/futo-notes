/**
 * Shared Tauri test client used by desktop and Android-backed harnesses.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';
import { executeJs, sleep } from './mcp-client.mjs';

const SCRIPT_EXECUTION_TIMEOUT = 'Script execution timeout';
const EXECUTE_JS_RETRY_ATTEMPTS = 3;

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
        notesShell: typeof window.__notesShellTest,
      })`,
      );
      const parsed = JSON.parse(String(result));
      if (parsed.testSync === 'object' && parsed.notesShell === 'object') return;
      lastError = null;
    } catch (error) {
      // The bridge can accept WebSocket connections before the webview is
      // ready to run JS. Treat early execute_js timeouts like a missing hook.
      if (error.message !== SCRIPT_EXECUTION_TIMEOUT) throw error;
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
    this.capabilities = {
      supportsHostExternalMutation: Boolean(notesDir),
    };
  }

  normalizeServerUrl(serverUrl) {
    const url = new URL(serverUrl);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      url.hostname = this.loopbackHost;
    }
    return url.toString();
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
  }

  async openNote(id) {
    const encodedId = encodeURIComponent(id);
    await this._executeMutation(`window.location.hash = '#/note/${encodedId}'`, 'openNote');
    await this.waitForRoute(`/note/${encodedId}`);
    await this.waitForEditorReady();
    await this.waitForOpenNote(id);
  }

  async setTitle(title) {
    return this._executeMutation(
      `(() => {
      const input = document.querySelector('.title-input');
      if (!(input instanceof HTMLTextAreaElement)) {
        throw new Error('title input not found');
      }
      input.focus();
      input.value = ${JSON.stringify(title)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`,
      'setTitle',
    );
  }

  async typeInEditor(text) {
    return this._executeMutation(
      `window.__notesShellTest.typeInEditor(${JSON.stringify(text)})`,
      'typeInEditor',
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

  // Blur the editor (moving DOM focus off .cm-content) and report whether it
  // is now unfocused. CodeMirror's updateListener fires focusChanged on the
  // blur, which drives the host's handleEditorFocusChange(false).
  async blurEditor() {
    return this._executeMutation(
      `(() => {
        const cm = document.querySelector('.cm-content');
        if (cm instanceof HTMLElement) cm.blur();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        return document.activeElement !== cm;
      })()`,
      'blurEditor',
    );
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

/**
 * Shared Tauri test client used by desktop and Android-backed harnesses.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeJs, sleep } from './mcp-client.mjs';

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
    } catch (err) {
      // The bridge can accept WebSocket connections before the webview is
      // ready to run JS. Treat early execute_js timeouts like a missing hook.
      lastError = err;
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

  async externalWriteNote(id, content) {
    if (!this.capabilities.supportsHostExternalMutation || !this.notesDir) {
      throw new Error(
        `${this.name}: external host note mutation is not supported on ${this.platform}`,
      );
    }
    writeFileSync(join(this.notesDir, `${id}.md`), content);
  }

  async writeNote(id, content) {
    return executeJs(
      this.ws,
      `window.__testNotes.writeNote(${JSON.stringify(id)}, ${JSON.stringify(content)})`,
    );
  }

  async readNote(id) {
    return executeJs(this.ws, `window.__testNotes.readNote(${JSON.stringify(id)})`);
  }

  async listNotes() {
    return executeJs(this.ws, `window.__testNotes.listNoteFiles()`);
  }

  async deleteNote(id) {
    return executeJs(this.ws, `window.__testNotes.deleteNoteFile(${JSON.stringify(id)})`);
  }

  // App-level delete: goes through the same path as a user delete, so the
  // notes cache is pruned synchronously. deleteNote() above is a raw FS
  // unlink for scenarios simulating EXTERNAL deletions — its watcher echo
  // can be suppressed when a sync pushes the tombstone first, leaving the
  // cache stale (which is correct to test for external edits, but races
  // when the scenario means "the user deleted a note in the app").
  async deleteNoteInApp(id) {
    return executeJs(this.ws, `window.__testNotes.deleteNote(${JSON.stringify(id)})`);
  }

  async deleteAllNotes() {
    return executeJs(this.ws, `window.__testNotes.deleteAllContent()`);
  }

  async noteExists(id) {
    return executeJs(this.ws, `window.__testNotes.noteExists(${JSON.stringify(id)})`);
  }

  async listFolders() {
    return executeJs(this.ws, `window.__testNotes.listFolders()`);
  }

  async createFolder(path) {
    return executeJs(this.ws, `window.__testNotes.createFolder(${JSON.stringify(path)})`);
  }

  async renameFolder(from, to) {
    return executeJs(
      this.ws,
      `window.__testNotes.renameFolder(${JSON.stringify(from)}, ${JSON.stringify(to)})`,
    );
  }

  async deleteFolder(path) {
    return executeJs(this.ws, `window.__testNotes.deleteFolder(${JSON.stringify(path)})`);
  }

  async moveNote(fromId, toId) {
    return executeJs(
      this.ws,
      `window.__testNotes.moveNote(${JSON.stringify(fromId)}, ${JSON.stringify(toId)})`,
    );
  }

  /** Like moveNote, but if the target ID already exists the incoming
   *  file is suffixed (`A/note` → `A/note-2`). Mirrors the UI-driven
   *  `moveNote` flow in `src/lib/notes.svelte.ts`. */
  async moveNoteWithCollisions(fromId, toId) {
    return executeJs(
      this.ws,
      `window.__testNotes.moveNoteWithCollisions(${JSON.stringify(fromId)}, ${JSON.stringify(toId)})`,
    );
  }

  async openNewNote() {
    await executeJs(this.ws, `window.location.hash = '#/note/new'`);
    await this.waitForRoute('/note/new');
    await this.waitForEditorReady();
  }

  async openNote(id) {
    const encodedId = encodeURIComponent(id);
    await executeJs(this.ws, `window.location.hash = '#/note/${encodedId}'`);
    await this.waitForRoute(`/note/${encodedId}`);
    await this.waitForEditorReady();
    await this.waitForOpenNote(id);
  }

  async setTitle(title) {
    return executeJs(
      this.ws,
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
    );
  }

  async typeInEditor(text) {
    return executeJs(this.ws, `window.__notesShellTest.typeInEditor(${JSON.stringify(text)})`);
  }

  async flushSave() {
    return executeJs(this.ws, `window.__notesShellTest.flushSave()`);
  }

  async getOpenNoteState() {
    return executeJs(this.ws, `window.__notesShellTest.getState()`);
  }

  // The MCP bridge (tauri-plugin-mcp-bridge) hard-caps execute_js at 5s.
  // Sync calls can exceed that (slow-proxy scenarios, 1000-note bulk sync),
  // so we kick off the promise into a window slot and poll for completion.

  async _kickOffAsync(slotRef, expression) {
    await executeJs(
      this.ws,
      `(() => {
      const slot = '__crossPlatformSyncCall_' + Math.random().toString(36).slice(2);
      window[slot] = { done: false };
      Promise.resolve(${expression}).then(
        (value) => { window[slot] = { done: true, value }; },
        (error) => { window[slot] = { done: true, error: String(error && error.message || error) }; },
      );
      window[${JSON.stringify(slotRef)}] = slot;
      return 'started';
    })()`,
    );
  }

  async _kickOffSync(slotRef) {
    await this._kickOffAsync(slotRef, 'window.__testSync.syncNow()');
  }

  async _awaitAsyncSlot(slotRef, timeoutMs, label) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await executeJs(
        this.ws,
        `(() => {
        const slot = window[${JSON.stringify(slotRef)}];
        if (!slot) return { missing: true };
        const state = window[slot];
        if (!state) return { missing: true };
        if (!state.done) return { pending: true };
        return state;
      })()`,
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
    await this._kickOffSync('__startedSyncSlot');
  }

  async awaitStartedSync({ timeoutMs = 180_000 } = {}) {
    return this._awaitSyncSlot('__startedSyncSlot', timeoutMs);
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
      const result = await executeJs(this.ws, script);
      if (result) return;
      await sleep(100);
    }
    throw new Error(`${this.name}: timed out waiting for ${label}`);
  }

  async connectSync(serverUrl, password, { timeoutMs = 180_000 } = {}) {
    await this._kickOffAsync(
      '__lastConnectSlot',
      `window.__testSync.connect(${JSON.stringify(this.normalizeServerUrl(serverUrl))}, ${JSON.stringify(password)})`,
    );
    return this._awaitAsyncSlot('__lastConnectSlot', timeoutMs, 'connectSync');
  }

  async syncNow({ timeoutMs = 180_000 } = {}) {
    await this._kickOffSync('__lastSyncSlot');
    return this._awaitSyncSlot('__lastSyncSlot', timeoutMs);
  }

  async disconnectSync() {
    return executeJs(this.ws, `window.__testSync.disconnect()`);
  }

  async syncStatus() {
    return executeJs(this.ws, `window.__testSync.status()`);
  }

  async pauseAutoSync() {
    return executeJs(this.ws, `window.__testSync.pauseAutoSync()`);
  }

  async resumeAutoSync() {
    return executeJs(this.ws, `window.__testSync.resumeAutoSync()`);
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

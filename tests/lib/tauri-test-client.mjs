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
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await executeJs(ws, `JSON.stringify({
      testSync: typeof window.__testSync,
      notesShell: typeof window.__notesShellTest,
    })`);
    const parsed = JSON.parse(String(result));
    if (parsed.testSync === 'object' && parsed.notesShell === 'object') return;
    await sleep(intervalMs);
  }

  const totalMs = initialDelayMs + (attempts * intervalMs);
  throw new Error(
    `${name}: test hooks not available after ${Math.round(totalMs / 1000)}s. Was the frontend built with VITE_INCLUDE_TEST_HOOKS=true?`,
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
      throw new Error(`${this.name}: external host note mutation is not supported on ${this.platform}`);
    }
    writeFileSync(join(this.notesDir, `${id}.md`), content);
  }

  async writeNote(id, content) {
    return executeJs(this.ws, `window.__TAURI__.core.invoke('fs_write_note', ${JSON.stringify({ id, content })})`);
  }

  async readNote(id) {
    return executeJs(this.ws, `window.__TAURI__.core.invoke('fs_read_note', ${JSON.stringify({ id })})`);
  }

  async listNotes() {
    return executeJs(this.ws, `window.__TAURI__.core.invoke('fs_list_note_files')`);
  }

  async deleteNote(id) {
    return executeJs(this.ws, `window.__TAURI__.core.invoke('fs_delete_note_file', ${JSON.stringify({ id })})`);
  }

  async deleteAllNotes() {
    return executeJs(this.ws, `window.__TAURI__.core.invoke('fs_delete_all_content')`);
  }

  async noteExists(id) {
    return executeJs(this.ws, `window.__TAURI__.core.invoke('fs_note_exists', ${JSON.stringify({ id })})`);
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
    return executeJs(this.ws, `(() => {
      const input = document.querySelector('.title-input');
      if (!(input instanceof HTMLTextAreaElement)) {
        throw new Error('title input not found');
      }
      input.focus();
      input.value = ${JSON.stringify(title)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`);
  }

  async typeInEditor(text) {
    return executeJs(this.ws, `(() => {
      const content = document.querySelector('.cm-content');
      if (!(content instanceof HTMLElement)) {
        throw new Error('editor content not found');
      }
      content.focus();
      document.execCommand('insertText', false, ${JSON.stringify(text)});
      return content.textContent ?? '';
    })()`);
  }

  async flushSave() {
    return executeJs(this.ws, `window.__notesShellTest.flushSave()`);
  }

  async getOpenNoteState() {
    return executeJs(this.ws, `window.__notesShellTest.getState()`);
  }

  async startSync() {
    await executeJs(this.ws, `(() => {
      window.__crossPlatformPendingSync = window.__testSync.syncNow();
      return 'started';
    })()`);
  }

  async awaitStartedSync() {
    return executeJs(this.ws, `window.__crossPlatformPendingSync`);
  }

  async waitForOpenNote(id, timeoutMs = 10_000) {
    return this.waitForCondition(`(() => {
      const state = window.__notesShellTest?.getState?.();
      return Boolean(state && state.originalId === ${JSON.stringify(id)});
    })()`, timeoutMs, `open note ${id}`);
  }

  async waitForRoute(path, timeoutMs = 10_000) {
    return this.waitForCondition(
      `window.location.hash === '#${path}'`,
      timeoutMs,
      `route ${path}`,
    );
  }

  async waitForEditorReady(timeoutMs = 10_000) {
    return this.waitForCondition(`(() => {
      return Boolean(document.querySelector('.cm-editor') && document.querySelector('.cm-content') && document.querySelector('.title-input'));
    })()`, timeoutMs, 'editor ready');
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

  async connectSync(serverUrl, password) {
    return executeJs(this.ws,
      `window.__testSync.connect(${JSON.stringify(this.normalizeServerUrl(serverUrl))}, ${JSON.stringify(password)})`);
  }

  async syncNow() {
    return executeJs(this.ws, `window.__testSync.syncNow()`);
  }

  async disconnectSync() {
    return executeJs(this.ws, `window.__testSync.disconnect()`);
  }

  async syncStatus() {
    return executeJs(this.ws, `window.__testSync.status()`);
  }

  async reset() {
    try { await this.disconnectSync(); } catch { /* may not be connected */ }
    try { await this.deleteAllNotes(); } catch { /* may have no notes */ }
  }

  stop() {
    try { this.ws.close(); } catch { /* ignore */ }
    try { this.stopProc?.(); } catch { /* ignore */ }
    try { this.proc?.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

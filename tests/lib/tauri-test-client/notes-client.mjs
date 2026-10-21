/**
 * The Tauri test client's note, folder and editor operations.
 */

import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeJs } from '../mcp-client.mjs';
import { TauriBridgeClient } from './bridge-client.mjs';

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

export class TauriNotesClient extends TauriBridgeClient {
  async externalWriteNote(id, content) {
    if (!this.capabilities.supportsHostExternalMutation || !this.notesDir) {
      throw new Error(
        `${this.name}: external host note mutation is not supported on ${this.platform}`,
      );
    }
    writeFileSync(join(this.notesDir, `${id}.md`), content);
  }

  /** An external editor's atomic save: write `tempName`, rename it onto the note. */
  async externalAtomicSaveNote(id, content, tempName) {
    if (!this.capabilities.supportsHostExternalMutation || !this.notesDir) {
      throw new Error(
        `${this.name}: external host note mutation is not supported on ${this.platform}`,
      );
    }
    const temp = join(this.notesDir, tempName);
    writeFileSync(temp, content);
    renameSync(temp, join(this.notesDir, `${id}.md`));
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

  // Hold every save of the open note (debug-only hook): while held a save
  // declines without writing, so a typed draft stays dirty and unsaved for as
  // long as a scenario needs — across a peer edit's pull or an external write.
  // Releasing writes nothing by itself; the scenario's next flushSave() does.
  async holdSaves(held) {
    return this._executeMutation(
      `window.__notesShellTest.holdSaves(${JSON.stringify(Boolean(held))})`,
      'holdSaves',
    );
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
}

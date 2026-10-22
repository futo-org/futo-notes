/**
 * The native Android client's editor driving: the WebView over CDP and the
 * open-note disposition log.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DEBUG_PACKAGE } from '../android-device.mjs';
import { AndroidNativeAppClient } from './app-client.mjs';
import {
  LIVE_TIMEOUT_MS,
  OPEN_NOTE_LOG_TAG,
  SAVE_TIMEOUT_MS,
  UI_TIMEOUT_MS,
} from './constants.mjs';

export class AndroidNativeEditorClient extends AndroidNativeAppClient {
  // ── Editor (WebView over CDP) ─────────────────────────────────

  async openNoteInEditor(id) {
    if (id.includes('/')) {
      throw new Error(`${this.name}: openNoteInEditor needs a top-level note, got ${id}`);
    }
    await this.openNoteList();
    await this.device.tap(id, { scroll: true });
    const onDisk = this.readNote(id);
    await this.device.waitFor(`${this.name}'s editor to load ${id}`, UI_TIMEOUT_MS, async () => {
      return (await this.readOpenEditorContent()) === onDisk;
    });
  }

  async readOpenEditorContent() {
    return this.#evaluateInEditor(
      'typeof window.FutoEditor === "object" && window.__futoTest.readDocument()',
    );
  }

  async waitForOpenEditorContent(expected, timeoutMs = LIVE_TIMEOUT_MS) {
    await this.device.waitFor(
      `${this.name}'s editor to hold ${JSON.stringify(expected.slice(0, 40))}`,
      timeoutMs,
      async () => (await this.readOpenEditorContent()) === expected,
    );
  }

  /**
   * Focus the editor the way a user's tap does, through the app's own focus
   * entry point (`EditorWebView.focusEditor`, via the debug `focus-editor` hook).
   *
   * Evaluating `window.FutoEditor.focus()` over CDP is only the DOM half, and it
   * can never succeed: Chromium withholds the focus event while the document
   * itself is unfocused, so `.ProseMirror-focused` stays unset and `document.hasFocus()`
   * stays false however long the wait is (measured on a foregrounded, accelerated
   * emulator — this was a missing step, not a slow one). The app's path also does
   * `webView.requestFocus()`, which is what lets the focus land; both halves have
   * to run, so the harness calls the app instead of half-reimplementing it.
   */
  async focusOpenEditor() {
    await this.device.callHook('focus-editor');
    await this.device.waitFor(`${this.name}'s editor to gain focus`, UI_TIMEOUT_MS, () =>
      // Both halves are asserted: `ProseMirror-focused` is the editor's own record of the focus
      // event, and `document.hasFocus()` is the native focus the DOM-only path
      // could not get. Either one alone would pass for a half-focused editor.
      this.#evaluateInEditor(
        `document.querySelector('.ProseMirror')?.classList.contains('ProseMirror-focused') === true &&
         document.hasFocus() === true`,
      ),
    );
  }

  /** Does the editor REALLY hold focus right now — the editor's own class plus the
   *  native focus behind it? Lets a scenario distinguish "the shell reported a
   *  blur" from "the editor was blurred". */
  async isOpenEditorFocused() {
    return this.#evaluateInEditor(
      `document.querySelector('.ProseMirror')?.classList.contains('ProseMirror-focused') === true &&
       document.hasFocus() === true`,
    );
  }

  /** Blur needs no hook: `EditorHost.blur()` — the toolbar's dismiss chevron —
   *  is exactly this `FutoEditor.blur()` eval and nothing else, so the DOM half
   *  IS the app's whole path here (contrast focusOpenEditor). */
  async blurOpenEditor() {
    await this.#evaluateInEditor(
      `(() => {
        window.FutoEditor.blur();
        return true;
      })()`,
    );
    await this.device.waitFor(`${this.name}'s editor to lose focus`, UI_TIMEOUT_MS, () =>
      this.#evaluateInEditor(
        `document.querySelector('.ProseMirror')?.classList.contains('ProseMirror-focused') !== true`,
      ),
    );
  }

  /** Type into the focused editor through the browser's own editing command,
   *  so ProseMirror handles it as input — an edit the editor itself decides
   *  when to report. Call focusOpenEditor first. */
  async typeIntoOpenEditor(text) {
    const typed = await this.#evaluateInEditor(
      `document.execCommand('insertText', false, ${JSON.stringify(text)})`,
    );
    if (typed !== true) throw new Error(`${this.name}: the editor refused typed input`);
  }

  /** Put the caret at the start of the first text run equal to `text`, and
   *  return once the browser has had the frames to tell ProseMirror (it reads a
   *  DOM caret move from an async `selectionchange`). Call focusOpenEditor first. */
  async placeCaretAtStartOf(text) {
    const placed = await this.#evaluateInEditor(
      `(() => {
        const walker = document.createTreeWalker(document.querySelector('.ProseMirror'), NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent !== ${JSON.stringify(text)}) continue;
          getSelection().collapse(node, 0);
          return new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done(true))),
          );
        }
        return false;
      })()`,
    );
    if (placed !== true)
      throw new Error(`${this.name}: no editor text run is ${JSON.stringify(text)}`);
  }

  /** Is the open note still streaming its tail ("Loading the rest…")? While it
   *  is, the editor withholds `change` (the save lock). */
  async isOpenEditorStreaming() {
    return this.#evaluateInEditor(`document.querySelector('.milkdown-stream-tail') !== null`);
  }

  /** Rename the open note the way a user does: focus the inline title field
   *  (its own text is the node label), replace the title, and let the editor's
   *  debounce commit it. Returns once the note exists under `newId` on disk. */
  async renameOpenNote(currentId, newId) {
    const field = await this.device.waitFor(`the title field of ${currentId}`, UI_TIMEOUT_MS, () =>
      this.device.findNode(currentId),
    );
    this.device.tapPoint(field.x, field.y);
    await this.device.waitFor(`the title field to accept input`, UI_TIMEOUT_MS, () =>
      this.device.isImeInputActive(),
    );
    this.device.typeReplacingSelection(newId);
    await this.device.waitFor(`${currentId} to be renamed to ${newId}`, SAVE_TIMEOUT_MS, () =>
      this.noteExists(newId),
    );
  }

  async waitForOpenEditorTitle(title, timeoutMs = LIVE_TIMEOUT_MS) {
    await this.device.waitFor(`"${title}" as ${this.name}'s open-note title`, timeoutMs, () =>
      this.device.isVisible(title),
    );
  }

  openNoteDispositionCursor() {
    return this.#openNoteDispositionLogs().length;
  }

  /** Every disposition the shell has rendered since `cursor`, newest last —
   *  what lets a scenario assert a settle happened EXACTLY once rather than
   *  merely at least once. `disposition` filters by kind when given. */
  openNoteDispositionsSince(cursor, disposition = null) {
    const lines = this.#openNoteDispositionLogs().slice(cursor);
    if (!disposition) return lines;
    return lines.filter((line) => line.includes(`disposition=${disposition} `));
  }

  /** Wait for the debug build's observation-only signal that the Android shell
   *  finished rendering an engine disposition. */
  async waitForOpenNoteDisposition(
    disposition,
    { focused, afterCursor, timeoutMs = LIVE_TIMEOUT_MS },
  ) {
    if (!Number.isInteger(afterCursor)) {
      throw new Error(`${this.name}: an open-note log cursor is required`);
    }
    const expected = `disposition=${disposition} focused=${focused ? 'true' : 'false'}`;
    await this.device.waitFor(`${this.name} to report ${expected}`, timeoutMs, () =>
      this.#openNoteDispositionLogs()
        .slice(afterCursor)
        .some((line) => line.includes(expected)),
    );
  }

  /** Exercise the shared component's whole-document user edit path through
   *  the debug test hook. Identity and generation come from the real editor. */
  async replaceOpenEditorContent(content) {
    const payload = JSON.stringify(content);
    await this.#evaluateInEditor(
      `(() => {
        window.__futoTest.replaceDocument(${payload});
        return 'sent';
      })()`,
    );
  }

  async waitForNoteMissing(id, timeoutMs = LIVE_TIMEOUT_MS) {
    await this.device.waitFor(`${id} to be absent from ${this.name}'s vault`, timeoutMs, () => {
      return !this.noteExists(id);
    });
  }

  /** Open `id`, make a whole-document user edit through the debug hook, and
   *  return once the app has written it to disk. */
  async editNoteViaEditor(id, content) {
    await this.openNoteInEditor(id);
    await this.replaceOpenEditorContent(content);
    await this.waitForNoteContent(id, content, SAVE_TIMEOUT_MS);
    await this.openNoteList();
  }

  async #evaluateInEditor(expression) {
    const port = await this.#cdpPort();
    // Reuse the documented CDP entry point (scripts/cdp-invoke.mjs) instead of
    // keeping a second copy of the DevTools protocol client in the harness.
    const stdout = execFileSync(
      'node',
      [join(this.repoRoot, 'scripts', 'cdp-invoke.mjs'), expression],
      {
        encoding: 'utf8',
        env: { ...process.env, CDP_PORT: String(port) },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return JSON.parse(stdout);
  }

  #openNoteDispositionLogs() {
    return this.device
      .adb(['logcat', '-d', '-s', `${OPEN_NOTE_LOG_TAG}:D`, '*:S'], { allowFailure: true })
      .split('\n')
      .filter((line) => line.includes('disposition='));
  }

  /** The DevTools socket is named after the app's pid, so a relaunch needs a
   *  fresh forward. */
  async #cdpPort() {
    const pid = this.device.shell(`pidof ${DEBUG_PACKAGE}`, { allowFailure: true }).trim();
    if (this.cdp.port && this.cdp.pid === pid) return this.cdp.port;
    const port = await this.device.forwardWebViewDebugger();
    this.cdp = { port, pid };
    return port;
  }
}

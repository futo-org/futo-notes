/** Native Android editor driving through the debug listener and platform input connection. */
import { portsFor } from '../../../scripts/lib/slot.mjs';
import { AndroidNativeAppClient } from './app-client.mjs';
import { LIVE_TIMEOUT_MS, SAVE_TIMEOUT_MS, UI_TIMEOUT_MS } from './constants.mjs';

export class AndroidNativeEditorClient extends AndroidNativeAppClient {
  async requestNative(path, args = {}) {
    const port = portsFor(this.repoRoot).puppetAndroid;
    this.device.adb(['forward', `tcp:${port}`, `tcp:${port}`]);
    const response = await fetch(`http://127.0.0.1:${port}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`${this.name}: ${path}: ${JSON.stringify(value)}`);
    return value;
  }
  async openNoteInEditor(id) {
    await this.openNoteList();
    await this.device.tap(id, { scroll: true });
    await this.device.waitFor(
      `native editor ${id}`,
      UI_TIMEOUT_MS,
      async () => (await this.requestNative('state')).editor?.ready === true,
    );
  }
  async readOpenEditorContent() {
    return (await this.requestNative('state')).editor?.source;
  }
  async waitForOpenEditorContent(expected, timeoutMs = LIVE_TIMEOUT_MS) {
    await this.device.waitFor(
      `native editor content`,
      timeoutMs,
      async () => (await this.readOpenEditorContent()) === expected,
    );
  }
  async focusOpenEditor() {
    await this.requestNative('do/FocusEditor');
  }
  async blurOpenEditor() {
    await this.requestNative('do/BlurEditor');
  }
  async isOpenEditorFocused() {
    return (await this.requestNative('state')).editor?.focused === true;
  }
  async typeIntoOpenEditor(text) {
    await this.requestNative('do/Type', { text });
  }
  async placeCaretAtStartOf(text) {
    const state = (await this.requestNative('state')).editor;
    if (state.truncated) throw new Error('caret lookup needs an untruncated native display');
    const from = state.display.indexOf(text);
    if (from < 0) throw new Error(`native editor does not contain ${text}`);
    await this.requestNative('do/Select', { from, to: from });
  }
  async replaceOpenEditorContent(text) {
    const state = (await this.requestNative('state')).editor;
    if (state.truncated) throw new Error('whole-document replacement needs an untruncated display');
    await this.requestNative('do/Select', { from: 0, to: state.display.length });
    await this.requestNative('do/Insert', { text });
  }
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
}

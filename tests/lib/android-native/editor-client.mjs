/** Native Android editor driving through the debug listener and platform input connection. */
import { AndroidNativeAppClient } from './app-client.mjs';
import { LIVE_TIMEOUT_MS, SAVE_TIMEOUT_MS, UI_TIMEOUT_MS } from './constants.mjs';

export class AndroidNativeEditorClient extends AndroidNativeAppClient {
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
}

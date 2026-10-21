/**
 * The native Android client's app-level driving: screens, the sync session in
 * Settings, and reads of the device vault.
 */

import { join } from 'node:path';
import { rewriteLoopbackHost } from '../tauri-test-client.mjs';
import {
  CONNECT_TIMEOUT_MS,
  EMULATOR_HOST_LOOPBACK,
  LIVE_TIMEOUT_MS,
  NOTE_LIST_MARKER,
  SETTINGS_SYNC_ROW_LABEL,
  SETTINGS_SYNC_SECTION_MARKER,
  UI_TIMEOUT_MS,
  USE_MY_OWN_SERVER_LABEL,
} from './constants.mjs';

export class AndroidNativeAppClient {
  constructor({ name, repoRoot, device }) {
    this.name = name;
    this.platform = 'android-native';
    this.repoRoot = repoRoot;
    this.device = device;
    this.cdp = { port: null, pid: null };
  }

  get vaultPath() {
    return this.device.vaultPath();
  }

  // ── Screens ───────────────────────────────────────────────────

  async completeFirstRunIfNeeded() {
    const startScreen = await this.device.waitFor(
      'the note list or the storage picker',
      UI_TIMEOUT_MS,
      () => {
        const screen = this.device.screen();
        if (screen.has('Where should your notes live?')) return 'picker';
        if (screen.has(NOTE_LIST_MARKER)) return 'list';
        return this.#stepTowardNoteList();
      },
    );
    if (startScreen !== 'picker') return;
    // App storage needs no "All files access" grant, so onboarding completes
    // without the system permission screen.
    await this.device.tap('App storage');
    await this.device.tap('Continue');
    await this.device.waitFor('the seeded vault', UI_TIMEOUT_MS, () =>
      this.device.listDir(this.vaultPath).includes('Welcome.md'),
    );
  }

  /** Walk back to the note list from wherever the app currently is. */
  async openNoteList() {
    await this.device.waitFor('the note list', UI_TIMEOUT_MS, () => {
      if (this.device.isVisible(NOTE_LIST_MARKER)) return true;
      this.#stepTowardNoteList();
      return false;
    });
  }

  /** One step out of whatever screen is up. Back from the note list leaves the
   *  app, so a lost app is relaunched rather than pressed back forever. */
  #stepTowardNoteList() {
    if (!this.device.isForeground()) {
      this.device.launch();
    } else {
      this.device.pressBack();
    }
    return null;
  }

  /** Reach Settings → Sync from any screen: note list → top-bar gear → Sync,
   *  and past the hosted wizard's "Use my own server" disclosure when a
   *  hosted build renders it, one dumped snapshot per step. */
  async openSyncScreen() {
    await this.device.waitFor('the sync screen', UI_TIMEOUT_MS, () => {
      const screen = this.device.screen();
      if (screen.has('Disconnect') || screen.has('Connect & Sync')) return true;
      // A tap aimed at a row would land on the keyboard while it is up.
      if (this.device.isImeVisible()) {
        this.device.pressBack();
        return false;
      }
      const next =
        screen.node(USE_MY_OWN_SERVER_LABEL) ??
        (screen.has(SETTINGS_SYNC_SECTION_MARKER) ? screen.node(SETTINGS_SYNC_ROW_LABEL) : null) ??
        (screen.has(NOTE_LIST_MARKER) ? screen.node('Settings') : null);
      if (next) {
        this.device.tapPoint(next.x, next.y);
      } else {
        this.#stepTowardNoteList();
      }
      return false;
    });
  }

  // ── Sync session (Settings → Sync) ────────────────────────────

  async connectSync(serverUrl, password) {
    const url = rewriteLoopbackHost(serverUrl, EMULATOR_HOST_LOOPBACK);
    // A no-op when the previous scenario already tore the session down.
    await this.disconnectSync();

    await this.#fillField('Server URL', url, { expectVisibleValue: true });
    await this.#fillField('Password', password);
    // The soft keyboard covers the buttons; a tap would land on a key instead
    // (and silently type into the field), so drop the IME before tapping.
    await this.#dismissKeyboard();

    await this.device.tap('Connect & Sync', { scroll: false });
    // Connected == the session buttons replaced the connect form. The status
    // line is user-facing copy, so it is never the assertion (AGENTS.md M15).
    try {
      await this.device.waitFor(`${this.name} to connect to ${url}`, CONNECT_TIMEOUT_MS, () =>
        this.device.isVisible('Disconnect'),
      );
    } catch {
      throw new Error(
        `${this.name}: connect to ${url} did not complete — screen showed: ${this.#visibleLabelsForDiagnostics()}`,
      );
    }
  }

  async disconnectSync() {
    await this.openSyncScreen();
    if (!this.device.isVisible('Disconnect')) return;
    await this.device.tap('Disconnect', { scroll: false });
    await this.device.waitFor('the disconnected sync screen', UI_TIMEOUT_MS, () =>
      this.device.isVisible('Connect & Sync'),
    );
  }

  /** Tap "Sync now". The caller waits on the sync's OUTCOME (a file on disk, a
   *  row in the list) rather than on a status string, which is user-facing copy
   *  a cross-platform test must not assert (AGENTS.md M15). */
  async syncNow() {
    await this.openSyncScreen();
    await this.device.tap('Sync now', { scroll: false });
  }

  /** Type `value` into the labeled text field, replacing whatever is there.
   *  `expectVisibleValue` re-types once if the IME dropped characters — only
   *  usable for a field that renders its value (a password renders as dots). */
  async #fillField(label, value, { expectVisibleValue = false } = {}) {
    const field = await this.device.waitFor(`the "${label}" field`, UI_TIMEOUT_MS, () =>
      this.device.findNode(label),
    );
    // The label is drawn inside the text field's box, so its center focuses the
    // field itself.
    this.device.tapPoint(field.x, field.y);
    await this.device.waitFor(`the "${label}" field to accept input`, UI_TIMEOUT_MS, () =>
      this.device.isImeInputActive(),
    );
    this.device.typeReplacingSelection(value);
    if (!expectVisibleValue) return;
    await this.device.waitFor(`"${label}" to hold ${value}`, UI_TIMEOUT_MS, () => {
      if (this.device.isVisible(value)) return true;
      this.device.typeReplacingSelection(value);
      return false;
    });
  }

  async #dismissKeyboard() {
    if (!this.device.isImeVisible()) return;
    this.device.pressBack();
    await this.device.waitFor(
      'the keyboard to close',
      UI_TIMEOUT_MS,
      () => !this.device.isImeVisible(),
    );
  }

  #visibleLabelsForDiagnostics() {
    return this.device
      .visibleNodes()
      .map((node) => node.label)
      .filter((label) => label.trim())
      .slice(0, 12)
      .join(' | ');
  }

  // ── Vault reads (the device's own disk is the source of truth) ─

  readNote(id) {
    return this.device.readFile(join(this.vaultPath, `${id}.md`));
  }

  noteExists(id) {
    return this.device.fileExists(join(this.vaultPath, `${id}.md`));
  }

  listNoteFilenames() {
    return this.device.listDir(this.vaultPath).filter((name) => name.endsWith('.md'));
  }

  /** External (non-app) write into the vault — the "edited on another client
   *  while this one was offline" half of a conflict scenario. */
  externalWriteNote(id, content) {
    this.device.writeFile(join(this.vaultPath, `${id}.md`), content);
  }

  async waitForNoteContent(id, expected, timeoutMs = LIVE_TIMEOUT_MS) {
    await this.device.waitFor(
      `${this.name} to hold ${JSON.stringify(expected.slice(0, 40))} in ${id}`,
      timeoutMs,
      () => this.readNote(id) === expected,
    );
  }

  /** The Compose list itself, not just the disk — this is the `onLivePull` →
   *  `NotesStore.reload()` glue a pull has to drive. */
  async waitForNoteInList(title, timeoutMs = LIVE_TIMEOUT_MS) {
    await this.openNoteList();
    await this.device.waitFor(`"${title}" in ${this.name}'s note list`, timeoutMs, () =>
      this.device.isVisible(title),
    );
  }
}

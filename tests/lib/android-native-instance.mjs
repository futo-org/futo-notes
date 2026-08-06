/**
 * Native Android client for the cross-platform sync harness.
 *
 * The shipping Android app is the Compose shell in `apps/android` over the
 * shared Rust core (futo-notes-ffi) with the editor in a WebView. It has no MCP
 * bridge and no `window.__testSync` — those are Tauri-desktop only — so this
 * client drives the REAL app the way a user does: Settings → Sync for the
 * session, the note list for navigation, and the editor WebView over CDP for
 * content. That is the point: the Rust sync engine is already covered by the
 * desktop legs, and what this exercises is the Android shell glue (FFI session
 * wiring, the live loop across an offline window, the editor's save-and-push
 * chain, and list refresh on a live pull).
 *
 * Safety: this NEVER wipes the app. No `pm clear`, no uninstall, no vault
 * delete — an instrumented-test teardown once wiped a personal phone's dev
 * vault. Between scenarios it removes only the notes it created (the
 * `HARNESS_NOTE_PREFIX`) plus the sync checkpoint files, so a pre-existing dev
 * vault survives a run. Physical devices additionally need an explicit opt-in
 * (see findAndroidLegDevice).
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { AndroidDevice, DEBUG_PACKAGE, listAttachedDevices } from './android-device.mjs';
import { rewriteLoopbackHost } from './tauri-test-client.mjs';

/** The emulator reaches host services (the harness sync server) through this. */
const EMULATOR_HOST_LOOPBACK = '10.0.2.2';

/** Every note this harness creates on the device starts with this, so cleanup
 *  can never touch a note the harness did not write. */
export const HARNESS_NOTE_PREFIX = 'xsync-';

/** Sync checkpoint/ancestry files the Rust core keeps in the vault root — stale
 *  ones would resume a new scenario's fresh server from a dead cursor. */
const SYNC_STATE_FILES = ['.e2ee-state.json', '.e2ee-ancestry.json'];

// An accessibility-tree dump costs ~2 s on an emulator and a screen change can
// need several, so UI waits are generous by construction, not by flake-chasing.
const UI_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 60_000;
const SAVE_TIMEOUT_MS = 20_000;
// A live delivery normally lands in a second or two over SSE; the core's ~45 s
// safety poll is the backstop when an event is missed, so wait past it before
// calling live sync broken.
const LIVE_TIMEOUT_MS = 90_000;
const OPEN_NOTE_LOG_TAG = 'FutoOpenNote';

/**
 * Decide whether this machine can run the Android leg right now.
 *
 * @returns {{available: true, serial: string} | {available: false, reason: string}}
 */
export function findAndroidLegDevice() {
  const attached = listAttachedDevices();
  if (attached.length === 0) {
    return { available: false, reason: 'no adb device is attached' };
  }

  const requested = process.env.ANDROID_SERIAL;
  let serial;
  if (requested) {
    if (!attached.includes(requested)) {
      return {
        available: false,
        reason: `$ANDROID_SERIAL=${requested} is not attached (attached: ${attached.join(', ')})`,
      };
    }
    serial = requested;
  } else if (attached.length > 1) {
    // adb forward ports and device claims are machine-global: never guess which
    // of several devices is ours (`just qa-claim android` prints the serial).
    return {
      available: false,
      reason: `${attached.length} devices attached and $ANDROID_SERIAL is unset — run just qa-claim android`,
    };
  } else {
    serial = attached[0];
  }

  const device = new AndroidDevice(serial);
  if (!device.isResponsive()) {
    return { available: false, reason: `${serial} is attached but not answering adb shell` };
  }
  // A sync run rewrites the dev app's sync session (server URL + stored
  // password) and writes notes into its vault. That is free on a pool emulator
  // and intrusive on someone's phone, so a physical device must opt in.
  if (!device.isEmulator && process.env.FUTO_SYNC_TEST_ALLOW_PHYSICAL_DEVICE !== '1') {
    return {
      available: false,
      reason: `${serial} is a physical device — the leg rewrites the dev app's sync session; set FUTO_SYNC_TEST_ALLOW_PHYSICAL_DEVICE=1 to opt in`,
    };
  }
  if (!device.isPackageInstalled()) {
    return {
      available: false,
      reason: `${DEBUG_PACKAGE} is not installed on ${serial} — run just android-native`,
    };
  }
  return { available: true, serial };
}

/**
 * Launch (or foreground) the debug app and return a client the sync scenarios
 * can drive. Completes first-run onboarding on App storage when the picker is
 * up; a device that is already onboarded keeps its storage choice.
 */
export async function startAndroidNativeInstance(name, repoRoot, serial) {
  const device = new AndroidDevice(serial);
  const client = new AndroidNativeSyncClient({ name, repoRoot, device });
  device.launch();
  await client.completeFirstRunIfNeeded();
  await client.openNoteList();
  return client;
}

class AndroidNativeSyncClient {
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
        if (screen.has('All notes')) return 'list';
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
      if (this.device.isVisible('All notes')) return true;
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

  /** Reach Settings → Sync from any screen: note list → drawer → Settings →
   *  Self-hosted sync, one dumped snapshot per step. */
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
        screen.node('Self-hosted sync') ??
        (screen.has('LIBRARY') ? screen.node('Settings') : null) ??
        (screen.has('All notes') ? screen.node('Folders') : null);
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

  /** Type `value` into the labelled text field, replacing whatever is there.
   *  `expectVisibleValue` re-types once if the IME dropped characters — only
   *  usable for a field that renders its value (a password renders as dots). */
  async #fillField(label, value, { expectVisibleValue = false } = {}) {
    const field = await this.device.waitFor(`the "${label}" field`, UI_TIMEOUT_MS, () =>
      this.device.findNode(label),
    );
    // The label is drawn inside the text field's box, so its centre focuses the
    // field itself.
    this.device.tapPoint(field.x, field.y);
    await this.device.waitFor(`the "${label}" field to accept input`, UI_TIMEOUT_MS, () =>
      this.device.isImeVisible(),
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
      'typeof window.FutoEditor === "object" && window.FutoEditor.getContent()',
    );
  }

  async waitForOpenEditorContent(expected, timeoutMs = LIVE_TIMEOUT_MS) {
    await this.device.waitFor(
      `${this.name}'s editor to hold ${JSON.stringify(expected.slice(0, 40))}`,
      timeoutMs,
      async () => (await this.readOpenEditorContent()) === expected,
    );
  }

  async focusOpenEditor() {
    await this.#evaluateInEditor(
      `(() => {
        window.FutoEditor.focus();
        return true;
      })()`,
    );
    await this.device.waitFor(`${this.name}'s editor to gain focus`, UI_TIMEOUT_MS, () =>
      this.#evaluateInEditor(
        `document.querySelector('.cm-editor')?.classList.contains('cm-focused') === true`,
      ),
    );
  }

  async blurOpenEditor() {
    await this.#evaluateInEditor(
      `(() => {
        window.FutoEditor.blur();
        return true;
      })()`,
    );
    await this.device.waitFor(`${this.name}'s editor to lose focus`, UI_TIMEOUT_MS, () =>
      this.#evaluateInEditor(
        `document.querySelector('.cm-editor')?.classList.contains('cm-focused') !== true`,
      ),
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

  /** Post the same bridge message as a real editor change. `setContent` alone
   *  repaints the WebView without reaching the native save pipeline. */
  async replaceOpenEditorContent(content) {
    const payload = JSON.stringify(content);
    await this.#evaluateInEditor(
      `(() => {
        window.FutoEditor.setContent(${payload});
        window.futoBridge.postMessage(JSON.stringify({ type: 'change', content: ${payload} }));
        return 'sent';
      })()`,
    );
  }

  async waitForNoteMissing(id, timeoutMs = LIVE_TIMEOUT_MS) {
    await this.device.waitFor(`${id} to be absent from ${this.name}'s vault`, timeoutMs, () => {
      return !this.noteExists(id);
    });
  }

  /** Open `id`, replace its text through the shipping editor bridge, and
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

  // ── Lifecycle ─────────────────────────────────────────────────

  async foreground() {
    this.device.launch();
    await this.device.waitFor(`${this.name} to return to the foreground`, UI_TIMEOUT_MS, () =>
      this.device.isForeground(),
    );
  }

  /** A REAL offline window (airplane mode). Backgrounding is not enough: an
   *  SSE pull already in flight can land after `pauseLive`, which silently turns
   *  a conflict scenario into a fast-forward — measured, not assumed. */
  async goOffline() {
    this.device.setAirplaneMode(true);
    await this.device.waitFor(
      `${this.name} to lose the host`,
      UI_TIMEOUT_MS,
      () => !this.device.canReach(EMULATOR_HOST_LOOPBACK),
    );
  }

  async goOnline() {
    this.device.setAirplaneMode(false);
    await this.device.waitFor(`${this.name} to reach the host again`, UI_TIMEOUT_MS, () =>
      this.device.canReach(EMULATOR_HOST_LOOPBACK),
    );
  }

  // ── Between scenarios ─────────────────────────────────────────

  async reset() {
    // A failed scenario can leave the phone offline or deep in a screen.
    await this.goOnline();
    await this.foreground();
    await this.disconnectSync();
    for (const name of this.listNoteFilenames()) {
      if (name.startsWith(HARNESS_NOTE_PREFIX)) {
        this.device.removeFile(join(this.vaultPath, name));
      }
    }
    for (const name of SYNC_STATE_FILES) {
      this.device.removeFile(join(this.vaultPath, name));
    }
    await this.openNoteList();
  }

  /** Release only what this harness allocated. The app stays installed and its
   *  vault stays where it is; the radios go back on so an interrupted run cannot
   *  leave the device in airplane mode. */
  stop() {
    this.device.setAirplaneMode(false);
    this.device.releaseForwards();
  }
}

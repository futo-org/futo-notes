/**
 * Native Android client for the cross-platform sync harness.
 *
 * The shipping Android app is the Compose shell in `apps/android` over the
 * shared Rust core (futo-notes-ffi) with the editor in a WebView. It has no MCP
 * bridge and no `window.__testSync` — those are Tauri-desktop only — so this
 * client drives the REAL app the way a user does: Settings → Sync for the
 * session, the note list for navigation, the editor WebView over CDP for
 * content, and the debug build's named hooks (MainActivity.testHooks) where a
 * step needs the app's own entry point rather than the DOM's (focusOpenEditor).
 * That is the point: the Rust sync engine is already covered by the
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

import { join } from 'node:path';
import { verifyAndroidApk } from '../../scripts/qa/android-apk.mjs';
import { AndroidDevice, DEBUG_PACKAGE, listAttachedDevices } from './android-device.mjs';
import {
  EMULATOR_HOST_LOOPBACK,
  HARNESS_NOTE_PREFIX,
  SYNC_STATE_FILES,
  UI_TIMEOUT_MS,
} from './android-native/constants.mjs';
import { AndroidNativeEditorClient } from './android-native/editor-client.mjs';

// Callers import the harness prefix from here, where it was declared.
export { HARNESS_NOTE_PREFIX };

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
  verifyAndroidApk({ serial });
  const client = new AndroidNativeSyncClient({ name, repoRoot, device });
  device.launch();
  await client.completeFirstRunIfNeeded();
  await client.openNoteList();
  return client;
}

class AndroidNativeSyncClient extends AndroidNativeEditorClient {
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
    // Every deletion above went around the app, which has no filesystem watcher
    // to notice it (docs/spec/sync.md — the desktop watcher has no Android
    // counterpart). Without this restart only the FIRST scenario after an app
    // launch runs against the vault the harness prepared: the second one
    // inherits a note list naming files that no longer exist and a sync state
    // describing a vault that is gone, and its notes then never appear however
    // long the wait is. Measured: a second `--android-only` run on the same
    // launch failed all six scenarios on delivery timeouts while the notes
    // themselves were sitting in the vault on disk.
    this.device.restart();
    this.cdp = { port: null, pid: null };
    await this.device.waitFor(`${this.name} to come back up`, UI_TIMEOUT_MS, () =>
      this.device.isForeground(),
    );
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

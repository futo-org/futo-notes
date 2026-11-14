/**
 * Android-leg scenarios: desktop and the native Android app sharing notes live.
 */

import { HARNESS_NOTE_PREFIX } from '../lib/android-native-instance.mjs';
import { sleep } from '../lib/mcp-client.mjs';
import { assert, assertEqual } from './waits-and-assertions.mjs';

// ── Android-leg scenarios ───────────────────────────────────────
//
// `android` is the REAL native Compose app driven through its own UI + editor
// native Linedown editor (tests/lib/android-native-instance.mjs); `desktop` is a Tauri client.
// The Rust sync engine is shared, so these assert only what the Android SHELL
// owns: the FFI session, the SSE live loop across the app lifecycle, the list
// refresh a pull must drive, and conflict copies landing in the device's vault.
// The Android side has no behavioral test hook: checks use the device vault,
// Compose semantics and the native debug listener.

/** Registry marker for scenarios that need the native Android client. Unlike
 *  `--matrix`, which picks ONE desktop pair, this leg is attached to the same
 *  run whenever a device is available. */
export const ANDROID_MATRIX = 'desktop-android';

export const ANDROID_SHARED_NOTE = `${HARNESS_NOTE_PREFIX}shared`;

export async function androidReceivesDesktopNoteLive(desktop, android, server) {
  await desktop.connectSync(server.url, server.password);
  await android.connectSync(server.url, server.password);

  const body = '# from desktop\nthis must reach Android with no tap on the phone';
  await desktop.writeNote(ANDROID_SHARED_NOTE, body);
  await desktop.syncNow();

  // The phone is never touched from here on: its Rust live loop has to pull…
  await android.waitForNoteContent(ANDROID_SHARED_NOTE, body);
  // …and the pull has to refresh the Compose list (SyncManager.onLivePull →
  // NotesStore.reload), which is the glue a desktop-only mesh cannot see.
  await android.waitForNoteInList(ANDROID_SHARED_NOTE);
}

export async function desktopReceivesAndroidEditorEdit(desktop, android, server) {
  await desktop.connectSync(server.url, server.password);
  await android.connectSync(server.url, server.password);

  const base = '# shared\nbase text';
  await desktop.writeNote(ANDROID_SHARED_NOTE, base);
  await desktop.syncNow();
  await android.waitForNoteContent(ANDROID_SHARED_NOTE, base);

  // Native input changes the Rust session, whose committed mutation triggers sync.
  const edited = '# shared\n\nedited in the Android editor\n';
  await android.editNoteViaEditor(ANDROID_SHARED_NOTE, edited);

  await waitForDesktopNoteContent(desktop, ANDROID_SHARED_NOTE, edited);
}

/** Poll the desktop client for content the phone pushed. Each iteration runs a
 *  bounded sync rather than trusting a fixed settle window. */
export async function waitForDesktopNoteContent(client, id, expected, timeoutMs = 90_000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    await client.syncNow();
    last = await client.readNote(id).catch(() => null);
    if (last === expected) return;
    await sleep(1_000);
  }
  throw new Error(
    `${client.name}: ${id} never became ${JSON.stringify(expected)} (last: ${JSON.stringify(last)})`,
  );
}

/** The losing edit, preserved under some other name in the device's vault. The
 *  assertion is that the TEXT survived — never the copy's generated filename. */
export async function waitForAndroidConflictCopy(android, id, expectedText, timeoutMs = 90_000) {
  const start = Date.now();
  let seen = [];
  while (Date.now() - start < timeoutMs) {
    seen = android
      .listNoteFilenames()
      .filter((name) => name.startsWith(HARNESS_NOTE_PREFIX) && name !== `${id}.md`)
      .map((name) => name.replace(/\.md$/, ''));
    const hit = seen.find((candidate) => android.readNote(candidate) === expectedText);
    if (hit) return hit;
    await sleep(1_000);
  }
  throw new Error(
    `${android.name}: the losing edit was not preserved as a conflict copy (other notes: ${JSON.stringify(seen)})`,
  );
}

// A note another client or the server wrote WITHOUT a final line ending must
// stay byte-for-byte as it is when Android scans, syncs, opens, focuses and blurs
// it. A rewrite here would make every client on a different version churn the
// same note forever.
export async function androidDoesNotRewriteARawNote(desktop, android, server) {
  await desktop.connectSync(server.url, server.password);
  await android.connectSync(server.url, server.password);

  const id = `${HARNESS_NOTE_PREFIX}raw-no-newline`;
  const raw = '# raw\nno final newline, written outside the app';
  android.externalWriteNote(id, raw);
  // Android has no filesystem watcher: a process restart is how it re-reads the vault.
  android.device.restart();
  await android.waitForNoteInList(id);
  await android.syncNow();
  await desktop.syncNow();
  await waitForDesktopNoteContent(desktop, id, raw);

  await android.openNoteInEditor(id);
  await android.focusOpenEditor();
  await android.blurOpenEditor();
  await android.syncNow();
  await desktop.syncNow();
  await sleep(5_000);

  assertEqual(android.readNote(id), raw, 'opening a raw note on Android must not rewrite it');
  assertEqual(await desktop.readNote(id), raw, 'the raw note must reach the desktop unchanged');
  const copies = android
    .listNoteFilenames()
    .filter((name) => name.startsWith(HARNESS_NOTE_PREFIX) && name !== `${id}.md`);
  assertEqual(
    JSON.stringify(copies.filter((name) => name.includes('raw'))),
    '[]',
    'a raw note must not spawn a conflict copy',
  );
}

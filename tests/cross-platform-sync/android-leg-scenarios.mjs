/**
 * Android-leg scenarios: desktop and the native Android app sharing notes live.
 */

import { HARNESS_NOTE_PREFIX } from '../lib/android-native-instance.mjs';
import { sleep } from '../lib/mcp-client.mjs';
import { assert, assertEqual } from './waits-and-assertions.mjs';

// ── Android-leg scenarios ───────────────────────────────────────
//
// `android` is the REAL native Compose app driven through its own UI + editor
// WebView (tests/lib/android-native-instance.mjs); `desktop` is a Tauri client.
// The Rust sync engine is shared, so these assert only what the Android SHELL
// owns: the FFI session, the SSE live loop across the app lifecycle, the list
// refresh a pull must drive, and conflict copies landing in the device's vault.
// The Android side has no behavioral test hook: checks use the device vault,
// Compose semantics, the shipping FutoEditor bridge, and observation-only
// debug logs.

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

  // A real editor edit on the phone: the WebView posts the bridge `change`
  // message, the shell debounces a write, and NotesStore's mutation hook tells
  // Rust a local note changed so the live loop pushes it.
  const edited = '# shared\n\nedited in the Android editor\n';
  await android.editNoteViaEditor(ANDROID_SHARED_NOTE, edited);

  await waitForDesktopNoteContent(desktop, ANDROID_SHARED_NOTE, edited);
}

export async function androidDefersFocusedPeerEditUntilBlur(desktop, android, server) {
  await desktop.connectSync(server.url, server.password);
  await android.connectSync(server.url, server.password);
  await desktop.pauseAutoSync();

  const id = `${HARNESS_NOTE_PREFIX}focused-open`;
  const base = '# focused on Android\nbase text';
  await desktop.writeNote(id, base);
  await desktop.syncNow();
  await android.waitForNoteContent(id, base);

  await android.openNoteInEditor(id);
  await android.focusOpenEditor();

  const peerEdit = '# focused on Android\npeer edit';
  const deferCursor = android.openNoteDispositionCursor();
  await desktop.writeNote(id, peerEdit);
  await desktop.syncNow();
  await android.waitForOpenNoteDisposition('DeferAdopt', {
    focused: true,
    afterCursor: deferCursor,
  });
  assertEqual(android.readNote(id), peerEdit, 'Android vault should contain the peer edit');
  assertEqual(
    await android.readOpenEditorContent(),
    base,
    'focused Android editor should not immediately adopt a peer edit',
  );

  // The BLUR has to be what settles it. Two checks first, so a settle that
  // happens without one turns into a precise failure instead of a timeout on the
  // Adopt wait below: the editor must still really be focused, and nothing must
  // have adopted yet. A shell that reports a blur the editor never had (the
  // lenient-DOM-focus class of bug) trips these, and the scenario then says so.
  assert(
    await android.isOpenEditorFocused(),
    'the Android editor lost real focus before the harness blurred it — the settle ' +
      'below would not be testing the blur path',
  );
  assertEqual(
    android.openNoteDispositionsSince(deferCursor, 'Adopt').length,
    0,
    'the deferral settled before any blur — the shell reported a blur the editor never had',
  );

  const adoptCursor = android.openNoteDispositionCursor();
  await android.blurOpenEditor();
  await android.waitForOpenNoteDisposition('Adopt', {
    focused: false,
    afterCursor: adoptCursor,
  });
  await android.waitForOpenEditorContent(peerEdit);
  assertEqual(
    android.openNoteDispositionsSince(adoptCursor, 'Adopt').length,
    1,
    'the deferred adopt must settle exactly once, not once per blur edge',
  );

  // …and the deferral must be CONSUMED, not left armed. A second focus/blur
  // edge is the probe: a still-armed deferral would settle again here. Driving
  // a real edge (rather than waiting out a window and hoping) is what makes
  // this a condition, not a sleep.
  const secondEdgeCursor = android.openNoteDispositionCursor();
  await android.focusOpenEditor();
  await android.blurOpenEditor();

  // The proof that the second edge's settle pass actually RAN — and found
  // nothing — is a fresh peer edit taken on the same pass ordering: it adopts
  // immediately (unfocused), and it is the ONLY disposition since the probe.
  const secondPeerEdit = '# focused on Android\nsecond peer edit';
  await desktop.writeNote(id, secondPeerEdit);
  await desktop.syncNow();
  await android.waitForOpenEditorContent(secondPeerEdit);
  assertEqual(
    android.openNoteDispositionsSince(secondEdgeCursor, 'Adopt').length,
    1,
    'a settled deferral must not re-settle on the next blur',
  );
}

// The other half of the deferral contract: a draft the user typed while a peer
// edit sat deferred is never replaced by that peer edit. A host that stashed the
// remote bytes at DeferAdopt and blindly applied them on blur passes the
// scenario above and destroys the user's text here.
//
// Deliberately asserts CONTENT, not the verdict name: whether the engine answers
// KeepDraft (the draft still un-flushed) or Leave (the debounced save already
// landed, so there is nothing remote left to adopt) depends on where the save
// debounce falls, and both answers must keep the same promise.
//
// BOTH texts survive, and neither is the note's id by luck: the settle keeps the
// PRE-pull baseline, so the resumed flush finds `current != base` and parks the
// draft as a conflict copy while the peer's bytes stay at the id (#89 — handing
// back the pulled bytes made that flush a fast-forward that destroyed them).
export async function androidKeepsADraftTypedWhileAPeerEditIsDeferred(desktop, android, server) {
  await desktop.connectSync(server.url, server.password);
  await android.connectSync(server.url, server.password);
  await desktop.pauseAutoSync();

  const id = `${HARNESS_NOTE_PREFIX}deferred-draft`;
  const base = '# deferred draft\nbase text';
  await desktop.writeNote(id, base);
  await desktop.syncNow();
  await android.waitForNoteContent(id, base);

  await android.openNoteInEditor(id);
  await android.focusOpenEditor();

  const peerEdit = '# deferred draft\npeer edit that must not win';
  const deferCursor = android.openNoteDispositionCursor();
  await desktop.writeNote(id, peerEdit);
  await desktop.syncNow();
  await android.waitForOpenNoteDisposition('DeferAdopt', {
    focused: true,
    afterCursor: deferCursor,
  });

  // The user keeps typing on top of the deferral — this is the draft that must
  // survive the blur.
  const localDraft = '# deferred draft\n\ntyped on the phone after the peer edit\n';
  await android.replaceOpenEditorContent(localDraft);
  await android.blurOpenEditor();

  // The phone's own text is what the phone still shows, and it reaches disk —
  // as its own note, not by overwriting the peer.
  assertEqual(
    await android.readOpenEditorContent(),
    localDraft,
    'a draft typed while a peer edit was deferred must not be clobbered on blur',
  );
  const conflictId = await waitForAndroidConflictCopy(android, id, localDraft);
  await android.waitForNoteContent(id, peerEdit);

  // And it is not a phone-only survival: both texts reach the fleet, so no
  // client is left having lost either edit.
  await waitForDesktopNoteContent(desktop, conflictId, localDraft);
  await waitForDesktopNoteContent(desktop, id, peerEdit);
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

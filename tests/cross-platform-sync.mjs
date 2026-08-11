#!/usr/bin/env node
/**
 * Cross-platform sync integration tests.
 *
 * Boots two Tauri test clients and a sync server, then runs deterministic
 * multi-client sync scenarios through the full client stack:
 *   editor/UI → note session save pipeline → autoSync/syncManager →
 *   Rust core → HTTP → server → and back.
 *
 * A second leg pairs a desktop client with the REAL native Android app when a
 * usable device is reachable, covering the Android shell glue the desktop pair
 * cannot see (FFI wiring, live-loop lifecycle, open-note reconciliation, list
 * refresh). With no device it prints a loud SKIP and runs the desktop-only mesh
 * — see runAndroidLeg.
 *
 * Usage:
 *   node tests/cross-platform-sync.mjs
 *   node tests/cross-platform-sync.mjs --scenario "five notes roundtrip"
 *   node tests/cross-platform-sync.mjs --no-android    (desktop mesh only)
 *   node tests/cross-platform-sync.mjs --android-only  (Android leg only; CI job)
 *
 * Requires:
 *   - Debug Tauri binary:  cd apps/tauri && cargo tauri build --debug --no-bundle
 *   - E2EE server repo:    ~/Developer/futo-notes-server (override: FUTO_NOTES_E2EE_SERVER_REPO)
 *   - Frontend built with: VITE_INCLUDE_TEST_HOOKS=true pnpm run build
 *   - Android leg only:    a booted device/emulator with the debug app
 *                          (just qa-claim android && just android-native)
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startDesktopTauriInstance } from './lib/tauri-instance.mjs';
import {
  HARNESS_NOTE_PREFIX,
  findAndroidLegDevice,
  startAndroidNativeInstance,
} from './lib/android-native-instance.mjs';
import { startServer } from './lib/sync-test-server.mjs';
import { sleep } from './lib/mcp-client.mjs';
import { xplatSyncBand } from '../scripts/lib/slot.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── CLI args ────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    scenario: { type: 'string' },
    matrix: { type: 'string', default: 'desktop-desktop' },
    // MR fast path: skip scenarios marked `slow` in the registry (scale
    // probes whose mechanisms are covered by cheap scenarios). Main and tag
    // pipelines, and local runs, execute everything.
    'skip-slow': { type: 'boolean', default: false },
    // Leave the Android leg out even when a device is reachable (fast local
    // desktop-only runs). No device at all skips it on its own, loudly.
    'no-android': { type: 'boolean', default: false },
    // Run ONLY the Android leg, and REQUIRE a usable device: the desktop mesh
    // is already covered by test:cross-platform-sync, so the dedicated
    // emulator job would be pointless work if it silently skipped (M11).
    'android-only': { type: 'boolean', default: false },
  },
});

if (args['android-only'] && args['no-android']) {
  console.error('--android-only and --no-android contradict each other');
  process.exit(1);
}

// ── Test harness ────────────────────────────────────────────────

const results = [];
// Slot-derived, like every other port in this repo (`node scripts/lib/slot.mjs`).
// It used to be a hardcoded 4000, so every worktree started allocating at the
// same port and the second run adopted the first's server + database.
const PORT_BAND = xplatSyncBand(REPO_ROOT);
// Two ports per scenario: the server, plus the delay proxy that
// sync-test-server.mjs parks next to it for syncDelayMs scenarios.
const PORTS_PER_SCENARIO = 2;
let serverPortCounter = PORT_BAND.base;
const suiteStartedAt = Date.now();
const timings = {
  bootstrapMs: 0,
  clientStartupMs: 0,
  serverSetupMs: 0,
  clientResetMs: 0,
  scenarioMs: 0,
};

/** Next port pair inside this worktree's band; never the next worktree's. */
function allocateServerPort() {
  const port = serverPortCounter;
  serverPortCounter += PORTS_PER_SCENARIO;
  if (port + PORTS_PER_SCENARIO - 1 > PORT_BAND.end) {
    throw new Error(
      `Out of ports: slot ${PORT_BAND.slot}'s band is ${PORT_BAND.base}-${PORT_BAND.end}, ` +
        `which fits ${Math.floor((PORT_BAND.end - PORT_BAND.base + 1) / PORTS_PER_SCENARIO)} ` +
        `scenarios. Walking past it would land on another worktree's ports — widen ` +
        `XPLAT_SYNC_BAND.stride in scripts/lib/slot.mjs instead.`,
    );
  }
  return port;
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function waitForOpenNoteTitle(client, expectedTitle, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await client.getOpenNoteState();
    if (state.title === expectedTitle) return state;
    await sleep(100);
  }
  throw new Error(
    `${client.name}: title did not become ${JSON.stringify(expectedTitle)} after ${timeoutMs}ms`,
  );
}

async function waitForEditorContent(client, expectedContent, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await client.getOpenNoteState();
    if (state.editorContent === expectedContent) return state;
    await sleep(100);
  }
  throw new Error(
    `${client.name}: editor content did not become ${JSON.stringify(expectedContent)} after ${timeoutMs}ms`,
  );
}

/**
 * Wait until the open note has no save pending — the settled, durable state.
 *
 * Deliberately one-directional: polling for savePending === TRUE races the app,
 * because a debounce window (500ms body / a blur flush's in-flight save) can
 * open and close between two bridge round trips. A scenario that needs to
 * observe an UNSAVED note must control the ordering instead of racing for it
 * (see client.composeNoteAndSyncNow), and one that just needs the edit on disk
 * should flushSave() and wait here.
 */
async function waitForSaveIdle(client, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await client.getOpenNoteState();
    if (state.savePending === false) return state;
    await sleep(50);
  }
  throw new Error(`${client.name}: savePending did not become false after ${timeoutMs}ms`);
}

async function createNoteViaEditor(client, title, content) {
  await client.openNewNote();
  await client.setTitle(title);
  await client.typeInEditor(content);
}

/**
 * Wait for the open-note session itself to satisfy [predicate].
 *
 * Never on toast copy. This used to wait for the exact string 'Note was deleted
 * during sync'; the app's wording was later shortened to 'Note was deleted' and
 * the scenario then failed for the one reason it was not testing, while the
 * behavior it WAS testing (the session closing) had worked all along — which is
 * why a cross-platform test must not assert user-facing strings (AGENTS.md M15).
 */
async function waitForOpenNoteState(client, description, predicate, timeoutMs = 10_000) {
  const start = Date.now();
  let state;
  while (Date.now() - start < timeoutMs) {
    state = await client.getOpenNoteState();
    if (predicate(state)) return state;
    await sleep(100);
  }
  throw new Error(
    `${client.name}: open note did not ${description} after ${timeoutMs}ms ` +
      `(state=${JSON.stringify(state)})`,
  );
}

async function waitForToastClear(client, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await client.getOpenNoteState();
    if (!state.toastMessage) return state;
    await sleep(100);
  }
  throw new Error(`${client.name}: toast did not clear after ${timeoutMs}ms`);
}

async function externalWriteNote(client, id, content) {
  await client.externalWriteNote(id, content);
}

/** Poll the sidebar for a note title, waiting up to timeoutMs. */
async function waitForNoteInSidebar(client, titleSubstring, timeoutMs = 5_000) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 500) {
    await sleep(500);
    const items = await client.readWebview(
      `[...document.querySelectorAll('.note-row, [data-note-id]')].map(el => (el.getAttribute('data-note-id') || el.textContent.trim()))`,
      'sidebar note list',
    );
    if (items.some((t) => t.includes(titleSubstring))) return;
  }
  throw new Error(`"${titleSubstring}" not found in ${client.name}'s sidebar after ${timeoutMs}ms`);
}

/** Get all note titles currently visible in the sidebar. */
async function getSidebarTitles(client) {
  return client.readWebview(
    `[...document.querySelectorAll('.note-row, [data-note-id]')].map(el => (el.getAttribute('data-note-id') || el.textContent.trim()))`,
    'sidebar note list',
  );
}

// ── Scenarios ───────────────────────────────────────────────────

async function editorRoundtripThroughRealSync(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Stop BOTH clients' background sync (incl. the SSE live stream) so the
  // explicit syncNows below deterministically own the push/pull.
  //  - B: with live sync on, B's SSE stream would fetch A's note first and the
  //    manual sync would see downloaded=0 / the sidebar would race the live rescan.
  //  - A: the write-once auto-push now lives in the Rust live loop — a local
  //    save fires `e2ee_note_changed` and the loop debounces (~1s) and pushes.
  //    With A's live stream up, that auto-push uploads the note before the
  //    explicit syncNow, making it observe uploaded=0. Pausing A's auto-sync
  //    closes the live stream so the explicit syncNow deterministically owns
  //    the upload. (Auto-push itself is covered by the SSE live-sync tests.)
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  const noteId = 'editor roundtrip';
  const body = '# Written in CodeMirror\nThis note should sync through the real save pipeline.';

  // A creates a new note through the actual editor path, with the note still
  // living ONLY in the editor buffer when the sync is requested: body + title +
  // syncNow() all happen in one page task, so no debounce or blur flush can
  // persist it first (the harness owns the ordering instead of racing it).
  await a.openNewNote();
  const composed = await a.composeNoteAndSyncNow(noteId, body);
  // Captured synchronously at the instant syncNow() was called, so these are
  // evidence rather than a poll that lands wherever it lands.
  assertEqual(
    composed.preSync.originalId,
    null,
    'new note should still be unsaved when the manual sync is requested',
  );
  assertEqual(
    composed.preSync.savePending,
    true,
    'the debounced editor save should still be pending when the manual sync is requested',
  );
  assertEqual(
    composed.preSync.editorContent,
    body,
    'the body should exist only in the editor buffer when the manual sync is requested',
  );
  // Nothing but the sync's own flushPendingSave can have written the note, so an
  // upload here IS the proof that a manual sync flushes the pending editor save
  // before pushing. Drop that flush and this assertion fails.
  assert(composed.summary.uploaded === 1, `A uploaded=${composed.summary.uploaded}, expected 1`);

  const postSyncState = await waitForSaveIdle(a);
  assertEqual(
    postSyncState.originalId,
    noteId,
    'manual sync should flush the pending editor save before syncing',
  );

  // B syncs — gets the note (auto-sync may have already fetched it, so
  // downloaded can be 0 or 1 depending on timing).  The important thing
  // is that B has the correct file on disk afterwards.
  const bResult = await b.syncNow();
  assert(
    bResult.summary.downloaded <= 1,
    `B downloaded=${bResult.summary.downloaded}, expected 0 or 1`,
  );

  const diskContent = await b.readNote(noteId);
  assertEqual(diskContent, body, `${noteId} content mismatch`);

  await waitForNoteInSidebar(a, noteId);
  await waitForNoteInSidebar(b, noteId);
  await b.openNote(noteId);
  await waitForOpenNoteTitle(b, noteId);
  await waitForEditorContent(b, body);
  const bSidebar = await getSidebarTitles(b);
  const syncedCount = bSidebar.filter((t) => t.includes(noteId)).length;
  assertEqual(syncedCount, 1, `B sidebar should show exactly one synced editor note`);
}

async function concurrentEditConflict(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Stop B's background sync (incl. SSE) so B's explicit syncNow owns the
  // conflict-producing pull. With live sync on, B's SSE stream would pull A's
  // version and resolve the conflict before the manual sync, leaving conflicts=0.
  await b.pauseAutoSync();

  // A creates a shared note and syncs
  await a.writeNote('shared note', '# Original');
  await a.syncNow();

  // B syncs to get the note
  await b.syncNow();
  const bContent = await b.readNote('shared note');
  assertEqual(bContent, '# Original', 'B should have original');

  // Both edit offline
  await a.writeNote('shared note', "# A's version");
  await b.writeNote('shared note', "# B's version");

  // A syncs first — wins
  await a.syncNow();

  // B syncs — gets conflict
  const bResult = await b.syncNow();
  assert(
    bResult.summary.conflicts > 0,
    `B should have conflicts, got ${bResult.summary.conflicts}`,
  );

  // B should have A's version as the canonical copy
  const bCanonical = await b.readNote('shared note');
  assertEqual(bCanonical, "# A's version", "B canonical should be A's version");

  // A picks up conflict copy so both have identical file sets
  await a.syncNow();
  const aFiles = await a.listNotes();
  const bFiles = await b.listNotes();
  const aNames = new Set(aFiles.map((f) => f.filename || f.name || f));
  const bNames = new Set(bFiles.map((f) => f.filename || f.name || f));
  assertEqual(aNames.size, bNames.size, 'A and B should have same number of files');

  // Verify both clients' sidebars show the shared note + conflict copy
  await waitForNoteInSidebar(b, 'shared note');
  const bSidebar = await getSidebarTitles(b);
  assert(
    bSidebar.length >= 2,
    `B sidebar should show at least 2 notes (original + conflict), got ${bSidebar.length}`,
  );
  assert(
    bSidebar.some((t) => t.includes('conflict')),
    `B sidebar should show a conflict copy, got: ${JSON.stringify(bSidebar)}`,
  );
}

async function threeWayMerge(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Own the push/pull: B asserts conflicts===0 and no conflict copies on its
  // explicit syncNow after both edit the SAME note. With either live loop up,
  // A's edit auto-pushes and B's live loop auto-pulls/auto-pushes B's edit at
  // uncontrolled times, so the 3-way merge can run in a background cycle and
  // spawn a conflict copy that the explicit-sync assertion then sees. The merge
  // is trigger-agnostic, so the explicit syncs exercise the same merge code
  // deterministically. Same family as the focused-open-note/editor-roundtrip
  // scenarios.
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  // Both get a shared note with distinct sections
  const baseContent = [
    '# Shopping List',
    '',
    '## Groceries',
    '- milk',
    '- eggs',
    '',
    '## Hardware',
    '- screws',
    '- nails',
  ].join('\n');
  await a.writeNote('shopping list', baseContent);
  await a.syncNow();

  await b.syncNow();
  const bBase = await b.readNote('shopping list');
  assertEqual(bBase, baseContent, 'B should have base content');

  // A edits Groceries section, B edits Hardware section — non-overlapping
  const aVersion = baseContent.replace('- eggs', '- eggs\n- butter');
  const bVersion = baseContent.replace('- nails', '- nails\n- bolts');
  await a.writeNote('shopping list', aVersion);
  await b.writeNote('shopping list', bVersion);

  // A syncs first
  await a.syncNow();

  // B syncs — should merge cleanly, no conflict
  const bResult = await b.syncNow();
  assertEqual(bResult.summary.conflicts, 0, 'non-overlapping edits should merge without conflicts');

  // Both should converge on the merged result
  const expectedMerged = baseContent
    .replace('- eggs', '- eggs\n- butter')
    .replace('- nails', '- nails\n- bolts');

  await a.syncNow();
  const aFinal = await a.readNote('shopping list');
  const bFinal = await b.readNote('shopping list');
  assertEqual(aFinal, expectedMerged, 'A should have merged content');
  assertEqual(bFinal, expectedMerged, 'B should have merged content');

  // No conflict copies should exist
  const aFiles = await a.listNotes();
  const conflictFiles = aFiles.filter((f) => {
    const name = f.filename || f.name || f;
    return name.includes('conflict');
  });
  assertEqual(conflictFiles.length, 0, 'clean merge should produce no conflict copies');
}

async function renamePropagation(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  // Own the push/pull on both clients (same live-sync race as the
  // focused-open-note scenario).
  //  - B: with its SSE live loop up, A's rename push wakes it and it pulls
  //    concurrently with b.syncNow(); if the delete ('old name') and the create
  //    ('new name') land on separate B pull cycles, B sees a lone deletion of
  //    the OPEN note first — it closes the note and surfaces a delete toast,
  //    failing both the "note follows the rename" and the "no delete/change
  //    toast" assertions. Owning the pull lands delete+create in one cycle that
  //    handleSyncComplete recognizes as a rename.
  //  - A: A does deleteNote then writeNote then syncNow; with A's live loop up,
  //    its auto-push can ship the lone delete before the create, so B pulls a
  //    bare deletion. Pausing A pushes both together in the explicit syncNow.
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  // A creates and syncs
  await a.writeNote('old name', '# My Note');
  await a.syncNow();

  // B syncs to get the note and opens it in the UI.
  await b.syncNow();
  const exists = await b.noteExists('old name');
  assert(exists, 'B should have old name');
  await b.openNote('old name');
  await waitForOpenNoteTitle(b, 'old name');

  // A renames (delete + create)
  await a.deleteNote('old name');
  await a.writeNote('new name', '# My Note');
  await a.syncNow();

  // B syncs through the real syncManager path and keeps the renamed note open.
  await b.syncNow();
  const oldExists = await b.noteExists('old name');
  const newExists = await b.noteExists('new name');
  assert(!oldExists, 'B should NOT have old name');
  assert(newExists, 'B should have new name');
  const content = await b.readNote('new name');
  assertEqual(content, '# My Note', 'new name content mismatch');
  const state = await waitForOpenNoteTitle(b, 'new name');
  assertEqual(state.originalId, 'new name', 'open note should track the remote rename');
  assertEqual(
    state.hash,
    `#/note/${encodeURIComponent('new name')}`,
    'route should follow the renamed note',
  );
  await sleep(1200);
  const stableState = await b.getOpenNoteState();
  assertEqual(
    stableState.originalId,
    'new name',
    'open note should remain stable after watcher aftermath',
  );
  assertEqual(
    stableState.hash,
    `#/note/${encodeURIComponent('new name')}`,
    'route should remain stable after watcher aftermath',
  );
  assert(
    stableState.toastMessage === '' || stableState.toastMessage === 'Sync complete',
    `remote rename should not surface a delete/change toast, got ${JSON.stringify(stableState.toastMessage)}`,
  );
}

async function collisionPlacementFollowsOpenNote(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  // Own the push/pull on both clients (same live-sync race family as
  // renamePropagation) so the collision lands in B's explicit syncNow and the
  // reported rename + canonical adopt arrive in ONE summary.
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  // A mints the OLDER object. Server object ids are uuidv7 (time-ordered), so
  // A's object is lexicographically smaller and deterministically wins any
  // filename collision against B's later object — no coin flip.
  await a.writeNote('stuff/shared', '# from A');
  await a.syncNow();

  // B pulls A's note, then creates and MAPS its own distinct 'shared' note
  // (synced before any rival exists under that name) and opens it.
  await b.syncNow();
  assert(await b.noteExists('stuff/shared'), 'B should have pulled A’s note');
  await b.writeNote('shared', '# from B');
  await b.syncNow();
  await b.openNote('shared');
  await waitForOpenNoteTitle(b, 'shared');

  // A moves its older object onto the name B has open. A same-basename move
  // is collapsed into a rename of the SAME object by the push-side pairing,
  // so the older (winning) object id survives. A has not pulled B's 'shared',
  // so the move lands cleanly on A.
  await a.moveNote('stuff/shared', 'shared');
  await a.syncNow();

  // B pulls the renamed rival. A's smaller object id wins the canonical name,
  // so the engine relocates B's locally-mapped note to
  // `shared (conflict <oid8>)` — a collision placement it must report as
  // rename intent in the summary, and B's open tab/editor must follow.
  const bResult = await b.syncNow();

  const bFiles = (await b.listNotes()).map((f) => f.filename || f.name || f);
  const conflictFile = bFiles.find((name) => name.includes('shared (conflict'));
  assert(conflictFile, `B should keep both rivals, got ${JSON.stringify(bFiles)}`);
  const conflictId = conflictFile.replace(/\.md$/, '');

  assertEqual(await b.readNote('shared'), '# from A', 'canonical name should hold A’s content');
  assertEqual(await b.readNote(conflictId), '# from B', 'conflict copy should hold B’s content');
  assert(!(await b.noteExists('stuff/shared')), 'B should not keep the pre-move path');

  // The relocation is reported in the summary itself — never inferred by the
  // shell from id patterns.
  const renames = bResult.summary.renamed ?? [];
  assert(
    renames.some((pair) => pair.fromId === 'shared' && pair.toId === conflictId),
    `summary should report the collision placement as a rename, got ${JSON.stringify(renames)}`,
  );

  const state = await waitForOpenNoteTitle(b, conflictId);
  assertEqual(state.originalId, conflictId, 'open note should follow the collision placement');
  assertEqual(state.editorContent, '# from B', 'editor should keep showing B’s own content');
  assertEqual(
    state.hash,
    `#/note/${encodeURIComponent(conflictId)}`,
    'route should follow the collision placement',
  );

  // The relocation renamed B's open note on disk (shared.md → the conflict
  // copy) and rewrote shared.md with A's content. Drive the file-watcher
  // events those mutations emit and AWAIT their handling — the resolved
  // handlers are the observable "external change processed" signal (M15),
  // replacing a fixed settle window. A followed collision placement must
  // survive its own watcher aftermath without closing the note or toasting a
  // delete.
  await b.deliverFileChange('unlink', 'shared.md');
  await b.deliverFileChange('add', conflictFile);
  await b.deliverFileChange('change', 'shared.md');
  const stableState = await b.getOpenNoteState();
  assertEqual(
    stableState.originalId,
    conflictId,
    'open note should remain stable after watcher aftermath',
  );
  assert(
    stableState.toastMessage === '' || stableState.toastMessage === 'Sync complete',
    `collision placement should not surface a delete/change toast, got ${JSON.stringify(stableState.toastMessage)}`,
  );

  // A converges on the identical file set (every client mints the same
  // loser name).
  await a.syncNow();
  const aFiles = (await a.listNotes()).map((f) => f.filename || f.name || f);
  assert(
    aFiles.includes(conflictFile),
    `A should mint the identical conflict name, got ${JSON.stringify(aFiles)}`,
  );
  assertEqual(await a.readNote('shared'), '# from A', 'A canonical should hold A’s content');
  assertEqual(await a.readNote(conflictId), '# from B', 'A conflict copy should hold B’s content');
}

async function focusedOpenNoteDefersPeerEditUntilBlur(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  // Pause B's background sync (poll + SSE live loop) so B's explicit syncNow
  // below deterministically OWNS the pull of A's update. Otherwise the Rust
  // live loop, woken by A's push, pulls "# Version 2" to disk concurrently
  // with the explicit syncNow: whichever writes first leaves the other with
  // downloaded=0 and an empty updatedIds, and the open-note reload only fires
  // for the cycle whose summary.updatedIds contains the note — so under CI
  // timing the two can split and neither reloads the editor (job 185887). The
  // reload path in handleSyncComplete is trigger-agnostic, so making the
  // explicit sync the sole puller exercises the same reload code, just
  // deterministically. Mirrors editDuringSyncKeepsLocalDraft's guard.
  await b.pauseAutoSync();
  // Also pause A. A's second write ("# Version 2") fires e2ee_note_changed and
  // A's Rust live loop (still up when only B was paused) debounces ~1s and
  // pushes it. Under a loaded runner that debounced push lands LATE and
  // interleaves with A's explicit syncNow below: the two writers of the
  // 'shared live' object can reorder so the server keeps Version 1, or the
  // explicit syncNow returns before the handed-off live-loop push completes —
  // either way B's owned pull downloads 0/V1 and the editor never reaches
  // Version 2 (job 185887 recurred on MR !66 after the B-only pause of
  // abfbf34). Pausing A makes the explicit syncNows the sole, ordered pushers.
  // Mirrors editorRoundtripThroughRealSync, which pauses A for this reason.
  await a.pauseAutoSync();

  await a.writeNote('shared live', '# Version 1');
  await a.syncNow();
  await b.syncNow();

  await b.openNote('shared live');
  await waitForEditorContent(b, '# Version 1');
  await b.focusEditor();

  await a.writeNote('shared live', '# Version 2\nRemote update');
  await a.syncNow();

  const bResult = await b.syncNow();
  assertEqual(
    bResult.summary.downloaded,
    1,
    `B downloaded=${bResult.summary.downloaded}, expected 1`,
  );
  const deferredState = await b.getOpenNoteState();
  assertEqual(
    deferredState.editorContent,
    '# Version 1',
    'focused editor should defer a peer update',
  );

  await b.blurEditor();
  const state = await waitForEditorContent(b, '# Version 2\nRemote update');
  assertEqual(
    state.originalId,
    'shared live',
    'open note should remain the same note after remote update',
  );
  // The remote content reload triggers a change event in the editor which starts
  // the save debounce.  Wait for it to settle before asserting no pending save.
  const settled = await waitForSaveIdle(b);
  assertEqual(settled.savePending, false, 'remote reload should not leave a local save pending');
}

async function editDuringSyncKeepsLocalDraft(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  // Pause B's background auto-sync so the manual sync below deterministically
  // owns the pull of A's update. Without this, an auto-sync poll firing
  // during A.syncNow's 1500ms server-delay window can consume the update
  // before B's explicit startSync() runs.
  await b.pauseAutoSync();

  await a.writeNote('taken sync title', '# Blocking title');
  await a.writeNote('during sync', '# Base');
  await a.syncNow();
  await b.syncNow();
  // The rename below must be BLOCKED by the duplicate-title guard, which checks
  // B's notes cache. syncNow() resolving doesn't guarantee the pulled note has
  // propagated into that cache yet — wait for it, otherwise the guard misses
  // and the rename falls through to the Rust auto-suffix (taken sync title-2).
  await waitForNoteInSidebar(b, 'taken sync title');

  await b.openNote('during sync');
  await waitForEditorContent(b, '# Base');
  await b.setTitle('taken sync title');
  // Title edits use a deliberate 10s debounce (TITLE_SAVE_DEBOUNCE_MS) so a
  // rename round-trip never fires mid-typing — longer than waitForSaveIdle's
  // 5s budget. Flush so the (duplicate-title-blocked) save settles now, exactly
  // as this scenario already does before its final savePending check below.
  await b.flushSave();
  await waitForSaveIdle(b);

  await a.writeNote('during sync', '# Remote update');
  await a.syncNow();

  await b.startSync();
  await sleep(200);
  await b.typeInEditor('\nLocal draft typed during sync');
  // Settle the typed draft the same way the app does on blur/navigation, then
  // wait for idle. Polling for savePending === true first (the old shape) races
  // the app: the blur flush that typing triggers can open and close the pending
  // window between two bridge round trips, and the wait then fails on a scenario
  // that is working correctly.
  await b.flushSave();
  await waitForSaveIdle(b);
  const draftDuringSync = (await b.getOpenNoteState()).editorContent;

  const bResult = await b.awaitStartedSync();
  assert(
    bResult.summary.downloaded === 1,
    `B downloaded=${bResult.summary.downloaded}, expected 1`,
  );

  const preservedState = await waitForEditorContent(b, draftDuringSync);
  assertEqual(
    preservedState.originalId,
    'during sync',
    'open note should remain on the local draft during sync',
  );
  assertEqual(
    preservedState.hash,
    `#/note/${encodeURIComponent('during sync')}`,
    'route should stay on the edited note during sync',
  );

  // Settle the protected draft: restoring a valid title unblocks the save, and
  // the draft parks against the pulled base rather than fast-forwarding over it
  // (#89). Both texts then reach the peer — the pulled update at the note's own
  // id, the draft as a conflict copy.
  await b.setTitle('during sync');
  await b.flushSave();
  await waitForSaveIdle(b);
  await b.syncNow();
  await a.syncNow();
  const aContent = await a.readNote('during sync');
  assertEqual(
    aContent,
    '# Remote update',
    'the pulled remote update must survive the protected draft settling',
  );
  const aFiles = (await a.listNotes()).map((f) => f.filename || f.name || f);
  const conflictCopy = aFiles.find((name) => String(name).includes('conflict'));
  assert(conflictCopy, `the protected draft must reach the peer as a conflict copy: ${aFiles}`);
  assertEqual(
    await a.readNote(String(conflictCopy).replace(/\.md$/, '')),
    draftDuringSync,
    'the conflict copy must hold the draft that was protected during sync',
  );
}

async function dirtyDraftSurvivesAPeerEditThenSettles(a, b, server) {
  // Issue #89 across two real clients, and the assertion no committed scenario
  // made: when a peer edit meets a DIRTY local draft, BOTH texts survive — the
  // peer's at the note's own id, the draft as a conflict copy. `flush_draft`
  // parks exactly when the draft's base no longer matches disk, so the baseline
  // the open-note reconcile leaves behind is what decides park vs clobber.
  // Rebasing it onto the pulled bytes puts the next flush on its `current ==
  // base` fast-forward arm and the peer's edit is destroyed with no copy
  // anywhere in the vault.
  //
  // The draft is held dirty the way externalWatcherProtectsDirtyDraftThenSettles
  // does it — a duplicate title blocks the save — rather than by keeping the
  // editor focused: CodeMirror's hasFocus() also requires document.hasFocus(),
  // so a background window's focus is not something a scenario can rely on.
  // This is the sync-pull twin of that watcher scenario, which asserts the same
  // park for an external disk write.
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Own the pull ordering explicitly: a background cycle waking on A's push
  // would race B's owned syncNow, and the open-note reconcile only runs for the
  // cycle whose summary names the note.
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  await a.writeNote('sync taken title', '# Blocking title');
  await a.writeNote('sync dirty draft', '# Base');
  await a.syncNow();
  await b.syncNow();
  await waitForNoteInSidebar(b, 'sync taken title');

  await b.openNote('sync dirty draft');
  await waitForEditorContent(b, '# Base');

  // Hold the draft unsaveable: the duplicate title blocks every save attempt,
  // so the typed line is still unpersisted when the peer edit arrives.
  await b.setTitle('sync taken title');
  await b.flushSave();
  await waitForSaveIdle(b);
  await b.typeInEditor('\nLocal draft');
  const typed = (await b.getOpenNoteState()).editorContent;
  assert(typed.includes('Local draft'), `B should hold the typed draft, got: ${typed}`);

  await a.writeNote('sync dirty draft', '# Base\nPeer edit');
  await a.syncNow();
  const pulled = await b.syncNow();
  assertEqual(
    pulled.summary.downloaded,
    1,
    `B downloaded=${pulled.summary.downloaded}, expected 1`,
  );

  // Unsaved work is never replaced: the pulled bytes did not reach the buffer.
  const kept = await b.getOpenNoteState();
  assert(
    kept.editorContent.includes('Local draft'),
    `the dirty draft must survive the peer edit, got: ${kept.editorContent}`,
  );

  // Restore a valid title so the kept draft can finally be persisted. The
  // engine parks it, leaving the peer's bytes where they are.
  await b.setTitle('sync dirty draft');
  await b.flushSave();
  await waitForSaveIdle(b);

  const settled = await b.getOpenNoteState();
  assert(
    settled.editorContent.includes('Local draft') || settled.editorContent.includes('Peer edit'),
    `the settle must leave the editor on real content, got: ${settled.editorContent}`,
  );
  assertEqual(
    await b.readNote('sync dirty draft'),
    '# Base\nPeer edit',
    "the peer's edit must survive the settle of the local draft",
  );
  const files = (await b.listNotes()).map((file) => file.filename || file.name || file);
  const conflictCopy = files.find((name) => String(name).includes('conflict'));
  assert(conflictCopy, `the parked draft must survive as a conflict copy, vault: ${files}`);
  const conflictContent = await b.readNote(String(conflictCopy).replace(/\.md$/, ''));
  assert(
    conflictContent.includes('Local draft'),
    `the conflict copy must hold the parked draft bytes, got: ${conflictContent}`,
  );
}

async function externalWatcherReloadsCleanNote(a, _b, _server) {
  await a.openNewNote();
  await a.setTitle('watch clean');
  await a.typeInEditor('# Clean note');
  await a.flushSave();
  await a.waitForOpenNote('watch clean');
  await a.openNote('watch clean');
  await waitForEditorContent(a, '# Clean note');
  await waitForToastClear(a);
  await sleep(1200);

  await externalWriteNote(a, 'watch clean', '# Changed externally');

  // Longer timeout than the 10s default: under Docker/xvfb the inotify
  // notification arrives slower than on a dev machine.
  const state = await waitForEditorContent(a, '# Changed externally', 30_000);
  assertEqual(
    state.originalId,
    'watch clean',
    'clean external change should keep the same note open',
  );
  assertEqual(
    state.hash,
    `#/note/${encodeURIComponent('watch clean')}`,
    'clean external change should keep the same route',
  );
  assertEqual(
    state.toastMessage,
    '',
    'clean external change should not show a draft-preservation toast',
  );
}

async function externalWatcherProtectsDirtyDraftThenSettles(a, _b, _server) {
  // A blocked dirty draft is protected from the external change; restoring a
  // valid title settles it — the draft parks as a conflict copy against the
  // changed disk base and the editor then adopts the external bytes.
  await a.openNewNote();
  await a.setTitle('taken title');
  await a.typeInEditor('# Other note');
  await a.flushSave();
  await a.waitForOpenNote('taken title');

  await a.openNewNote();
  await a.setTitle('watch dirty');
  await a.typeInEditor('# Original content');
  await a.flushSave();
  await a.waitForOpenNote('watch dirty');
  await a.openNote('watch dirty');
  await waitForEditorContent(a, '# Original content');

  await a.setTitle('taken title');
  await a.typeInEditor('\nLocal draft');
  await waitForSaveIdle(a);
  await sleep(1200);

  await externalWriteNote(a, 'watch dirty', '# Changed on disk');

  // Protection: wait until the watcher has processed the event (the storage
  // refresh surfaces the external bytes in the notes-cache preview), then
  // assert the blocked dirty draft still owns the editor — no silent adoption.
  await a.waitForCondition(
    `window.__testNotes.getAllNotes().some((n) => n.id === 'watch dirty' && (n.preview || '').includes('Changed on disk'))`,
    30_000,
    'watcher refreshed the notes projection with the external content',
  );
  const protectedState = await a.getOpenNoteState();
  assert(
    protectedState.editorContent.includes('Local draft'),
    'dirty draft must be protected from the external change while blocked',
  );

  // Settle: restore a valid title; the draft parks against the changed disk
  // base and the deferred adoption applies the external content.
  await a.setTitle('watch dirty');
  await a.flushSave();
  const adoptedState = await waitForEditorContent(a, '# Changed on disk', 30_000);
  assertEqual(
    adoptedState.originalId,
    'watch dirty',
    'settled external change should keep the disk-backed note open',
  );
  const diskContent = await a.readNote('watch dirty');
  assertEqual(
    diskContent,
    '# Changed on disk',
    'external disk content should remain on disk after the UI adopts it',
  );
  const files = (await a.listNotes()).map((f) => f.filename || f.name || f);
  const conflictCopy = files.find((name) => name.includes('conflict'));
  assert(conflictCopy, 'the parked draft must survive as a conflict copy');
  const conflictContent = await a.readNote(conflictCopy.replace(/\.md$/, ''));
  assert(
    conflictContent.includes('Local draft'),
    `the conflict copy must hold the parked draft bytes, got: ${conflictContent}`,
  );
}

async function deleteVsEdit(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Own the delete-then-edit ordering this scenario asserts ("B syncs first —
  // edit wins"). With the live loop running, a background cycle can push A's
  // delete or pull B's edit between the explicit steps below, so the "B first"
  // premise stops holding and A converges to the (correct, non-lossy) delete
  // instead of B's edit — the same contended-convergence hazard the sibling
  // scenarios (fileMovedToTwoFoldersByAandB, concurrentOfflineFolderRename,
  // fileMoveOnAEditOnB) pause auto-sync to avoid. Pausing here changes nothing
  // about the conflict tested (A deletes, B edits, both from the shared
  // baseline); it only makes the stated sync ordering real.
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  // Both get a shared note
  await a.writeNote('contested', '# Original');
  await a.syncNow();
  await b.syncNow();

  // A deletes, B edits
  await a.deleteNote('contested');
  await b.writeNote('contested', '# B edited this');

  // B syncs first — edit wins
  await b.syncNow();

  // A syncs to pick up B's version. Each cycle is push-first: A's push of its
  // stale delete hits a 409 (B already bumped the version) and the client
  // restores B's surviving edit, which the same cycle's pull confirms. Poll
  // rather than assume a fixed round count — the restore can trail the push by
  // a cycle. readNote returns "" (not an error) for an absent file, so read the
  // content directly and loop until it matches — a plain read cannot
  // distinguish "not pulled yet" from "gone".
  let aContent = '';
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await a.syncNow();
    aContent = await a.readNote('contested');
    if (aContent === '# B edited this') break;
    await sleep(500);
  }
  assertEqual(aContent, '# B edited this', "A should get B's edit back");
}

// F4: a peer deletes the note the observer currently has open. read_note
// returns "" for a missing file on Tauri, so the old post-sync reload adopted
// "" into the editor while the session stayed bound to the deleted id — the
// next keystroke re-created the file and undid the delete fleet-wide. The
// deleted-open-note branch must instead CLOSE the session (route → '/', toast)
// and leave the note deleted on both clients.
async function peerDeleteOfOpenNoteClosesEditor(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  // Pause B's background sync so B's explicit syncNow deterministically OWNS
  // the pull of A's delete — the deleted-open-note branch only fires for the
  // cycle whose summary.deletedIds contains the note (mirrors the
  // focused-open-note scenario).
  await b.pauseAutoSync();

  await a.writeNote('peer deletes me', '# Doomed content');
  await a.syncNow();
  await b.syncNow();

  await b.openNote('peer deletes me');
  await waitForEditorContent(b, '# Doomed content');
  // A read-only open can start a save debounce; let it settle so the note is
  // NOT dirty (a dirty draft would take the keep-local-draft branch instead).
  await waitForSaveIdle(b);

  // A deletes and pushes the tombstone.
  await a.deleteNote('peer deletes me');
  await a.syncNow();

  // B pulls the delete — its open editor must close.
  const bResult = await b.syncNow();
  assert(
    bResult.summary.deletedIds?.includes('peer deletes me'),
    `B should pull the delete; deletedIds=${JSON.stringify(bResult.summary.deletedIds)}`,
  );

  // The outcome is the session closing, not the wording it closes with.
  const closed = await waitForOpenNoteState(
    b,
    'close after the peer delete',
    (state) => state.originalId === null,
  );
  assert(
    closed.hash !== `#/note/${encodeURIComponent('peer deletes me')}`,
    `route should leave the deleted note; hash=${closed.hash}`,
  );

  // No resurrection: the note stays gone on both clients across more syncs.
  await b.syncNow();
  await a.syncNow();
  assert(!(await b.noteExists('peer deletes me')), 'B must not resurrect the deleted note');
  assert(!(await a.noteExists('peer deletes me')), 'A must not see the note resurrected');
}

async function lostStateRecovery(a, _b, server) {
  await a.connectSync(server.url, server.password);

  // A creates notes and syncs
  await a.writeNote('recover 1', '# Note 1');
  await a.writeNote('recover 2', '# Note 2');
  await a.writeNote('recover 3', '# Note 3');
  await a.syncNow();

  // Simulate lost app-state: disconnect then reconnect
  await a.disconnectSync();
  await a.connectSync(server.url, server.password);

  // Sync again — should recover without conflicts
  const result = await a.syncNow();
  assert(
    result.summary.conflicts === 0,
    `Recovery should not create conflicts, got ${result.summary.conflicts}`,
  );

  // All notes still exist
  assert(await a.noteExists('recover 1'), 'recover 1 should exist');
  assert(await a.noteExists('recover 2'), 'recover 2 should exist');
  assert(await a.noteExists('recover 3'), 'recover 3 should exist');
}

async function rapidReconnect(a, _b, server) {
  // Connect and disconnect 3 times (server rate limits /login to 5/min).
  for (let i = 0; i < 3; i++) {
    try {
      await a.connectSync(server.url, server.password);
    } catch (err) {
      throw new Error(`Connect failed on iteration ${i} (server ${server.url}): ${err.message}`);
    }
    const status = await a.syncStatus();
    assert(
      status.appState.serverUrl || status.preferences?.sync?.serverUrl,
      `Iteration ${i}: should have server URL after connect`,
    );
    await a.disconnectSync();
  }

  // Final connect — verify clean state
  await a.connectSync(server.url, server.password);
  const finalStatus = await a.syncStatus();
  assert(
    finalStatus.appState.fileHashes === undefined ||
      Object.keys(finalStatus.appState.fileHashes || {}).length === 0,
    'fileHashes should be empty after fresh connect',
  );
}

async function offlineAccumulation(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Pause live sync so the explicit cycles exercise batch upload and download.
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  for (let i = 0; i < 10; i++) {
    await a.writeNote(`a only ${i}`, `# A Note ${i}`);
  }

  for (let i = 0; i < 10; i++) {
    await b.writeNote(`b only ${i}`, `# B Note ${i}`);
  }

  const aResult = await a.syncNow();
  assertEqual(aResult.summary.uploaded, 10, 'A batch upload count');

  const bResult = await b.syncNow();
  assertEqual(bResult.summary.uploaded, 10, 'B batch upload count');
  assertEqual(bResult.summary.downloaded, 10, 'B batch download count');

  const aResult2 = await a.syncNow();
  assertEqual(aResult2.summary.downloaded, 10, 'A second batch download count');

  for (let i = 0; i < 10; i++) {
    assert(await a.noteExists(`b only ${i}`), `A should have b only ${i}`);
    assert(await b.noteExists(`a only ${i}`), `B should have a only ${i}`);
  }
}

/** Generate realistic note content with varying length (500–2000 bytes). */
function generateNoteContent(i) {
  const topics = [
    'meeting notes',
    'project plan',
    'research',
    'journal',
    'recipe',
    'book notes',
    'travel log',
    'todo list',
  ];
  const topic = topics[i % topics.length];
  const paragraphs = [
    `This is a ${topic} entry created on day ${i}. It contains the kind of freeform markdown that a real user would write — not just a header and two lines.`,
    `Some notes are short reminders. Others are long explorations of an idea that span multiple paragraphs, include bullet points, and reference other notes like [[weekly review]] or [[project alpha]].`,
    `## Key Points\n\n- First important observation about item ${i}\n- Second point that builds on the first\n- A third detail with a [[link to another note]]\n- Follow-up action needed by end of week`,
    `The quick brown fox jumps over the lazy dog. This sentence exists purely to add realistic bulk to the note content, simulating the kind of stream-of-consciousness writing that fills most personal notes.`,
    `## References\n\n> "The best way to predict the future is to invent it." — Alan Kay\n\nThis quote came up during discussion ${i}. It connects to the broader theme of [[proactive design]] and the work we started last quarter.`,
    `### Checklist\n\n- [x] Draft initial version\n- [x] Review with team\n- [ ] Incorporate feedback from review #${i}\n- [ ] Final polish and publish`,
  ];
  // Use 3–6 paragraphs based on note index for varying lengths
  const count = 3 + (i % 4);
  const body = paragraphs.slice(0, count).join('\n\n');
  return `# ${topic} ${i}\n\n${body}`;
}

async function largeSync(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  const COUNT = 1000;

  // Write directly to the notes directory — Tauri IPC can't reliably handle
  // 1000 sequential write_atomic_text calls (temp file timestamp collisions).
  const contentByIndex = {};
  for (let i = 0; i < COUNT; i++) {
    const id = `bulk ${String(i).padStart(4, '0')}`;
    const content = generateNoteContent(i);
    contentByIndex[i] = content;
    a.externalWriteNote(id, content);
  }

  // A syncs (auto-sync may have handled some already)
  const aResult = await a.syncNow();
  assert(
    aResult.summary.uploaded <= COUNT,
    `A uploaded=${aResult.summary.uploaded}, expected ≤${COUNT}`,
  );

  // B syncs — may need multiple passes because auto-sync and manual sync can
  // race on who fetches first, and the server may batch-deliver across passes.
  const bFiles = new Set();
  for (let attempt = 0; attempt < 5; attempt++) {
    await b.syncNow();
    const listed = await b.listNotes();
    for (const f of listed) {
      const name = f.filename || f.name || f;
      if (typeof name === 'string' && name.startsWith('bulk '))
        bFiles.add(name.replace(/\.md$/, ''));
    }
    if (bFiles.size >= COUNT) break;
    await sleep(500);
  }
  assert(
    bFiles.size === COUNT,
    `B ended with ${bFiles.size} bulk notes on disk, expected ${COUNT}`,
  );

  // Spot check a few — verify full content round-tripped correctly
  for (const i of [0, 499, 999]) {
    const content = await b.readNote(`bulk ${String(i).padStart(4, '0')}`);
    assertEqual(content, contentByIndex[i], `bulk ${i} content mismatch`);
  }
}

async function tombstoneDoesNotBlockNewNote(a, b, server) {
  await a.connectSync(server.url, server.password);

  // Create a note and sync it to the server
  await a.writeNote('Untitled', '# First');
  await a.syncNow();

  // Delete it IN THE APP (not a raw FS unlink) and sync — server creates a
  // tombstone. The app-level delete prunes the notes cache synchronously,
  // matching what a real user delete does. A raw deleteNote() here races:
  // the sync push records the deleted id as a sync write, which suppresses
  // the watcher's unlink event — on slow CI the cache then still holds
  // 'Untitled' when the new note picks its title, yielding "Untitled (1)".
  await a.deleteNoteInApp('Untitled');
  await a.syncNow();
  const gone = !(await a.noteExists('Untitled'));
  assert(gone, 'Untitled should be deleted');

  // Create a NEW note with the same auto-generated title, open it in the editor
  await a.openNewNote();
  await a.flushSave();
  const state1 = await a.getOpenNoteState();
  assertEqual(state1.title, 'Untitled', 'new note should get title Untitled');

  // Type content so the note has substance, then sync
  await a.typeInEditor('# Fresh note');
  await a.flushSave();
  await waitForSaveIdle(a);
  const syncResult = await a.syncNow();

  // The sync must NOT delete the note we just created
  assert(
    !syncResult.summary.deletedIds?.includes('Untitled'),
    'sync should not return Untitled in deletedIds',
  );

  // No spurious delete/change toast should appear. A clean manual sync may
  // still show the normal "Sync complete" toast.
  await sleep(500);
  const finalState = await a.getOpenNoteState();
  assert(
    finalState.toastMessage === '' || finalState.toastMessage === 'Sync complete',
    `no delete/change toast should appear after syncing re-created note, got ${JSON.stringify(finalState.toastMessage)}`,
  );
  assert(await a.noteExists('Untitled'), 'Untitled should still exist on disk');
}

// ── Folder support scenarios (added with folder-support v1) ─────
//
// Each scenario maps to one row in the conflict-resolution table in
// `Specs for folder support in FUTO Notes.md` § Sync conflict resolution.
// They exercise the full client stack so the path-as-ID + sync frame v2
// pieces are verified end-to-end.

async function folderRenameOnAEditOnB(a, b, server) {
  // "Folder rename on A + note edit inside on B → both apply"
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Own the a→b→a sync ordering: A's folder rename (delete+create) and B's edit
  // must reconcile in that order. Either live loop auto-pushing/pulling out of
  // order can orphan content or duplicate the note. Same contended-convergence
  // family as fileMoveOnAEditOnB.
  await a.pauseAutoSync();
  await b.pauseAutoSync();
  await a.writeNote('Specs/folder-support', '# Folders');
  await a.syncNow();
  await b.syncNow();
  assert(await b.noteExists('Specs/folder-support'), 'B should have nested note');

  // A renames the folder (delete + create paths)
  await a.deleteNote('Specs/folder-support');
  await a.writeNote('Specs/folders/folder-support', '# Folders');
  // B independently edits content at the old path
  await b.writeNote('Specs/folder-support', '# Folders\n\nNew section from B');

  // Sync — A first, then B
  await a.syncNow();
  await b.syncNow();
  await a.syncNow();

  // Either the rename or the edit lands; the other applies on top via
  // last-write-wins. We assert no orphaned content and no duplicate.
  const aHas = await a.noteExists('Specs/folders/folder-support');
  const bHas = await b.noteExists('Specs/folders/folder-support');
  assert(aHas || bHas, 'one client should have the renamed/edited note');
}

async function fileMoveOnAEditOnB(a, b, server) {
  // "File move to folder on A + edit on B → both apply"
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Own the whole push/pull on both clients: convergence here depends on the
  // exact a→b→a explicit sync ordering (A's move, then B's edit reconciled onto
  // the moved path, then A pulls it back). With either live loop up, A's move
  // (delete+create) or B's edit auto-pushes at an uncontrolled time and the
  // peer's live loop auto-pulls out of order, so a background cycle can strand
  // the edit on the deleted flat path or leave a transient duplicate path
  // (flake on MR !66 run-1). Pausing both makes the explicit syncs the sole
  // driver.
  await a.pauseAutoSync();
  await b.pauseAutoSync();
  await a.writeNote('grocery', '# Grocery');
  await a.syncNow();
  await b.syncNow();
  assert(await b.noteExists('grocery'), 'B should see the flat note');

  // A moves to a folder
  await a.deleteNote('grocery');
  await a.writeNote('Lists/grocery', '# Grocery');
  // B edits the flat path
  await b.writeNote('grocery', '# Grocery\nupdated');

  await a.syncNow();
  await b.syncNow();
  await a.syncNow();
  // After convergence, the peer edit should land on the moved path only.
  const aFiles = (await a.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
  const bFiles = (await b.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
  assertEqual(
    JSON.stringify(aFiles),
    JSON.stringify(['Lists/grocery']),
    'A should keep only the moved path',
  );
  assertEqual(
    JSON.stringify(bFiles),
    JSON.stringify(['Lists/grocery']),
    'B should keep only the moved path',
  );
  assertEqual(
    await a.readNote('Lists/grocery'),
    '# Grocery\nupdated',
    'A should have B edit at moved path',
  );
  assertEqual(
    await b.readNote('Lists/grocery'),
    '# Grocery\nupdated',
    'B should have B edit at moved path',
  );
}

async function fileMovedToTwoFoldersByAandB(a, b, server) {
  // "Same file moved to two different folders by A and B → last-write-wins"
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Own the a→b→a ordering that LWW convergence depends on; a background live
  // loop auto-pushing/pulling either move out of order breaks the deterministic
  // last-write. Same contended-convergence family as fileMoveOnAEditOnB.
  await a.pauseAutoSync();
  await b.pauseAutoSync();
  await a.writeNote('contested', '# Original');
  await a.syncNow();
  await b.syncNow();
  assert(await b.noteExists('contested'), 'B should see the flat note before move');

  // A moves to FolderA/, B moves to FolderB/. Both delete the flat path.
  await a.deleteNote('contested');
  await a.writeNote('FolderA/contested', '# Original');
  await b.deleteNote('contested');
  await b.writeNote('FolderB/contested', '# Original');

  // A syncs first; B syncs second. Server's last-write-wins reconciles.
  await a.syncNow();
  await b.syncNow();
  await a.syncNow();

  // After convergence both clients should agree on the later server write.
  const aFiles = (await a.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
  const bFiles = (await b.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
  assertEqual(
    JSON.stringify(aFiles),
    JSON.stringify(['FolderB/contested']),
    'A should converge to B move destination',
  );
  assertEqual(
    JSON.stringify(bFiles),
    JSON.stringify(['FolderB/contested']),
    'B should converge to B move destination',
  );
}

async function concurrentOfflineFolderRename(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Own the a→b→a ordering: both clients move the same notes to different
  // folders and convergence is to the later server write. A background live
  // loop reordering the pushes/pulls breaks it. Same contended-convergence
  // family as fileMovedToTwoFoldersByAandB.
  await a.pauseAutoSync();
  await b.pauseAutoSync();
  await a.writeNote('Specs/alpha', '# Alpha');
  await a.writeNote('Specs/beta', '# Beta');
  await a.syncNow();
  await b.syncNow();

  await a.createFolder('Docs');
  await a.moveNote('Specs/alpha', 'Docs/alpha');
  await a.moveNote('Specs/beta', 'Docs/beta');
  await b.createFolder('Archive');
  await b.moveNote('Specs/alpha', 'Archive/alpha');
  await b.moveNote('Specs/beta', 'Archive/beta');

  await a.syncNow();
  await b.syncNow();
  await a.syncNow();

  const aFiles = (await a.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
  const bFiles = (await b.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
  const expected = ['Archive/alpha', 'Archive/beta'];
  assertEqual(
    JSON.stringify(aFiles),
    JSON.stringify(expected),
    'A should converge to the later folder rename',
  );
  assertEqual(
    JSON.stringify(bFiles),
    JSON.stringify(expected),
    'B should converge to the later folder rename',
  );
}

async function moveNoteIntoFolderDeleteFolder(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Own the push/pull on both clients: convergence depends on the a→b→a
  // explicit sync ordering (A's move into X, B's create+delete-X plus edit,
  // then A pulls the merged result). With either live loop up, the moves/edits
  // auto-push and the peer auto-pulls out of order, which can strand the edit
  // or leave a transient extra path (flake on MR !64 run-1). Pausing both makes
  // the explicit syncs the sole driver.
  await a.pauseAutoSync();
  await b.pauseAutoSync();
  await a.writeNote('draft-note-01', '# Draft');
  await a.syncNow();
  await b.syncNow();

  await a.createFolder('X');
  await a.moveNote('draft-note-01', 'X/draft-note-01');
  await b.createFolder('X');
  await b.deleteFolder('X');
  await b.writeNote('draft-note-01', '# Draft\n\nedited while X was deleted');

  await a.syncNow();
  await b.syncNow();
  await a.syncNow();

  const aFiles = (await a.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
  const bFiles = (await b.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
  assertEqual(
    JSON.stringify(aFiles),
    JSON.stringify(['X/draft-note-01']),
    'A should have one moved draft path',
  );
  assertEqual(
    JSON.stringify(bFiles),
    JSON.stringify(['X/draft-note-01']),
    'B should have one moved draft path',
  );
  assertEqual(
    await a.readNote('X/draft-note-01'),
    '# Draft\n\nedited while X was deleted',
    'A should have merged edit at moved path',
  );
  assertEqual(
    await b.readNote('X/draft-note-01'),
    '# Draft\n\nedited while X was deleted',
    'B should have merged edit at moved path',
  );
}

async function localRenameAndEditInSameSync(a, b, server) {
  // Single client renames a note AND edits its content before syncing.
  // Exercises pair_local_moved_objects: the rename must collapse into
  // a single PUT at the new filename (preserving object_id), and the
  // edit must land in the same blob — not a DELETE + POST that would
  // tombstone the object and lose the peer-visible history.
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Own the push: pair_local_moved_objects only collapses the rename+edit into
  // one in-place PUT if A's single explicit syncNow carries BOTH together. With
  // A's live loop up, its ~1s debounced auto-push can ship the rename before the
  // edit (or as a separate cycle), defeating the pairing the scenario asserts.
  // Pause B too so its explicit pull owns the download. Same family.
  await a.pauseAutoSync();
  await b.pauseAutoSync();
  await a.writeNote('grocery', '# Grocery');
  await a.syncNow();
  await b.syncNow();
  assert(await b.noteExists('grocery'), 'B should see the flat note before A renames');

  // A renames AND edits in one local transaction (no sync between).
  await a.deleteNote('grocery');
  await a.writeNote('Lists/grocery', '# Grocery\n\nMilk, eggs, bread');

  await a.syncNow();
  await b.syncNow();

  const aFiles = (await a.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
  const bFiles = (await b.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
  assertEqual(
    JSON.stringify(aFiles),
    JSON.stringify(['Lists/grocery']),
    'A should have only the renamed path',
  );
  assertEqual(
    JSON.stringify(bFiles),
    JSON.stringify(['Lists/grocery']),
    'B should pick up the rename',
  );
  assertEqual(
    await a.readNote('Lists/grocery'),
    '# Grocery\n\nMilk, eggs, bread',
    'A should see the edited content',
  );
  assertEqual(
    await b.readNote('Lists/grocery'),
    '# Grocery\n\nMilk, eggs, bread',
    'B should see the edited content',
  );
}

async function multipleLocalMovesInOneSync(a, b, server) {
  // Single client renames THREE notes simultaneously before syncing.
  // pair_local_moved_objects must pair all three independently by
  // basename — and B's pull side must see three in-place renames, not
  // tombstone+create pairs.
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Own the push so all three renames land in ONE explicit syncNow (the "in one
  // sync" this scenario is named for). A's live loop would auto-push each
  // debounced save separately, so pair_local_moved_objects would never see them
  // as a batch. Pause B too so its explicit pull owns the download. Same family.
  await a.pauseAutoSync();
  await b.pauseAutoSync();
  await a.writeNote('apple', '# Apple');
  await a.writeNote('banana', '# Banana');
  await a.writeNote('cherry', '# Cherry');
  await a.syncNow();
  await b.syncNow();

  // Move all three from root into Fruit/.
  await a.deleteNote('apple');
  await a.writeNote('Fruit/apple', '# Apple');
  await a.deleteNote('banana');
  await a.writeNote('Fruit/banana', '# Banana');
  await a.deleteNote('cherry');
  await a.writeNote('Fruit/cherry', '# Cherry');

  await a.syncNow();
  await b.syncNow();

  const expected = ['Fruit/apple', 'Fruit/banana', 'Fruit/cherry'];
  const aFiles = (await a.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
  const bFiles = (await b.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
  assertEqual(
    JSON.stringify(aFiles),
    JSON.stringify(expected),
    'A should have all three moved paths',
  );
  assertEqual(
    JSON.stringify(bFiles),
    JSON.stringify(expected),
    'B should converge to all three moved paths',
  );
}

async function bothClientsRenameToSameDestination(a, b, server) {
  // Two clients independently make the SAME rename (same source, same
  // destination). With pair_local_moved_objects on both sides, each
  // pushes a PUT at the new filename; the second client's PUT 409s,
  // resolve_update_conflict sees remote.path matches its own filename
  // (target_filename == filename branch), 3-way merges (clean — both
  // have identical content), and converges without producing a copy.
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Own the a→b→a ordering so the second client's PUT deterministically 409s
  // and drives resolve_update_conflict (the path this scenario exercises). A
  // background live loop pushing either rename early scrambles which PUT
  // conflicts. Same contended-convergence family.
  await a.pauseAutoSync();
  await b.pauseAutoSync();
  await a.writeNote('shared', '# Shared');
  await a.syncNow();
  await b.syncNow();
  assert(await b.noteExists('shared'), 'B should see the flat note before both rename');

  // Both clients move shared → Docs/shared with identical content.
  await a.deleteNote('shared');
  await a.writeNote('Docs/shared', '# Shared');
  await b.deleteNote('shared');
  await b.writeNote('Docs/shared', '# Shared');

  await a.syncNow();
  await b.syncNow();
  await a.syncNow();

  const aFiles = (await a.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
  const bFiles = (await b.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
  assertEqual(
    JSON.stringify(aFiles),
    JSON.stringify(['Docs/shared']),
    'A should have only the moved path',
  );
  assertEqual(
    JSON.stringify(bFiles),
    JSON.stringify(['Docs/shared']),
    'B should have only the moved path',
  );
  assertEqual(await a.readNote('Docs/shared'), '# Shared', 'A content unchanged');
  assertEqual(await b.readNote('Docs/shared'), '# Shared', 'B content unchanged');
}

async function folderXVsFileXAtSameLevel(a, b, server) {
  // "Folder X/ on A + file X.md on B at the same level → both persist"
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  // A creates a folder named "Reports" with a note inside (so the folder
  // syncs — empty folders are local-only). B creates a file literally
  // named "Reports.md" at root. After sync both must coexist on each
  // client because they're different on-disk entries.
  await a.writeNote('Reports/q1', '# Q1 report');
  await b.writeNote('Reports', '# Single-file report');

  await a.syncNow();
  await b.syncNow();
  await a.syncNow();

  assert(await a.noteExists('Reports/q1'), 'A should still have the nested note');
  assert(await b.noteExists('Reports/q1'), 'B should have downloaded the nested note');
  assert(await a.noteExists('Reports'), 'A should have downloaded the flat sibling');
  assert(await b.noteExists('Reports'), 'B should still have its flat note');
}

async function moveIntoFolderWithExistingFilename(a, _b, _server) {
  // "Move into a folder where filename already exists → suffix incoming"
  // Local-only behavior — exercises the unit of `moveNote` against an
  // already-occupied target. Cross-platform sync isn't required here;
  // we just verify the client logic on a single instance.
  await a.writeNote('A/note', '# A');
  await a.writeNote('B/note', '# B');
  await a.moveNoteWithCollisions('B/note', 'A/note');
  // After the move the B/note path should be gone, and A should now hold
  // both the original A/note and a uniquely-suffixed second copy.
  assert(!(await a.noteExists('B/note')), 'B/note should be gone after move');
  assert(await a.noteExists('A/note'), 'original A/note should still exist');
  const files = (await a.listNotes()).map((f) => (f.name || f.filename || f).replace(/\.md$/, ''));
  const suffixed = files.filter((id) => id.startsWith('A/note') && id !== 'A/note');
  assert(
    suffixed.length === 1,
    `expected one suffixed copy under A/, got ${JSON.stringify(suffixed)}`,
  );
}

async function emptyFolderDoesNotSync(a, b, server) {
  // "Empty folder created on A → local-only; does not sync"
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Create a real empty folder on A through __testNotes.createFolder.
  await a.createFolder('GhostFolder');
  // Sanity: A sees the folder locally.
  const aFolders = await a.listFolders();
  assert(
    aFolders.some((f) => (f.path || f) === 'GhostFolder'),
    'A should see the empty folder it just created',
  );
  await a.syncNow();
  await b.syncNow();
  // B must NOT see the empty folder — empty folders are git-style
  // local-only state (Spec § 5).
  const bFolders = await b.listFolders();
  assert(
    !bFolders.some((f) => (f.path || f) === 'GhostFolder'),
    'B must not see an empty folder created on A — it should not sync',
  );
  // Now add a note to the folder on A and sync; the folder should now
  // propagate (because its first descendant note carries the path).
  await a.writeNote('GhostFolder/first', '# First note in the folder');
  await a.syncNow();
  await b.syncNow();
  assert(await b.noteExists('GhostFolder/first'), 'B should have the nested note after sync');
  const bFoldersAfter = await b.listFolders();
  assert(
    bFoldersAfter.some((f) => (f.path || f) === 'GhostFolder'),
    'B should now see the folder once a note inside it has synced',
  );
}

async function unportableNameNeverSyncsAndIsLeftAlone(a, b, server) {
  // "A file whose name no portable filesystem can hold is left strictly alone:
  //  it never syncs, it never breaks the cycle, and it is never touched on disk."
  //
  // The name has to be planted externally because the app itself cannot mint
  // one — sanitizeTitle strips `:` — which is exactly how these files arrive in
  // real vaults: an Obsidian folder, a git clone, a Syncthing share, or a file
  // made on macOS/Linux where `:` is a legal filename character.
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  const unportable = 'Recipe: braised short ribs';
  await a.externalWriteNote(unportable, '# Braised short ribs\n\n3 hours at 160C.');
  await a.writeNote('portable control', '# Control note');

  await a.syncNow();
  const bFirstCycle = await b.syncNow();

  // The discriminating assertion: before this change A uploaded the file and B
  // raised a PERMANENT `rejected` failure for it on every cycle, forever. The
  // rest of this scenario passes either way — the absence of a failure is what
  // proves the fix.
  const bFailures = bFirstCycle?.summary?.failures ?? [];
  assert(
    bFailures.length === 0,
    `B must record no sync failure for an unportable name, got ${JSON.stringify(bFailures)}`,
  );

  // The control note proves the cycle ran and was not aborted by its neighbour.
  assert(
    await b.noteExists('portable control'),
    'B should have the control note — the unportable name must not break the cycle',
  );
  assert(
    !(await b.noteExists(unportable)),
    'B must not receive a note whose name no portable filesystem can hold',
  );
  assert(
    !existsSync(join(b.notesDir, `${unportable}.md`)),
    'B must not have the unportable file on disk either',
  );

  // And it survives on A, untouched, across repeated cycles — the push side
  // skips it without ever treating it as a local delete.
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await a.syncNow();
    await b.syncNow();
  }
  const stillThere = join(a.notesDir, `${unportable}.md`);
  assert(
    existsSync(stillThere),
    `A must still hold ${unportable}.md — it is never renamed or removed`,
  );
  assert(
    readFileSync(stillThere, 'utf8').includes('3 hours at 160C'),
    'the unportable file is left byte-for-byte alone',
  );
}

// A real (tiny) PNG. Non-UTF-8 bytes — exactly the kind of content that the
// old `.md`-only, read_to_string sync pipeline could never carry. We assert
// the bytes survive byte-for-byte across the E2EE round-trip.
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

// Regression for the "image markdown syncs but the image itself doesn't"
// bug: image binaries were never scanned/uploaded/downloaded, so the
// `![](…)` reference arrived on the peer pointing at a file that didn't
// exist. The image now rides the object map alongside its note (base64 in the
// note frame), so the bytes must land on B identical to A.
async function imageSyncRoundtrip(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Explicit syncNow owns the upload/download (see editorRoundtrip rationale).
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  const imageName = 'image-sync-test.png';
  // Drop the image binary into A's vault — the same place the paste/picker
  // handler writes it — and a note that embeds it.
  writeFileSync(join(a.notesDir, imageName), SAMPLE_PNG);
  await a.writeNote('photo note', `# Photo\n\n![](${imageName})\n`);

  const aResult = await a.syncNow();
  assert(
    aResult.summary.uploaded >= 2,
    `A should upload the note AND the image (uploaded=${aResult.summary.uploaded}, expected >=2)`,
  );

  await b.syncNow();

  // The note reference arrives…
  const bNote = await b.readNote('photo note');
  assert(bNote.includes(`![](${imageName})`), `B note is missing the image reference`);

  // …AND so does the image file, byte-for-byte (this is what used to fail).
  const bImagePath = join(b.notesDir, imageName);
  assert(existsSync(bImagePath), `image binary did not arrive on B at ${bImagePath}`);
  const bBytes = readFileSync(bImagePath);
  assert(
    Buffer.compare(bBytes, SAMPLE_PNG) === 0,
    `image bytes differ on B (got ${bBytes.length} bytes, expected ${SAMPLE_PNG.length})`,
  );

  // Re-syncing must NOT re-upload the image (fast-path size accounting holds
  // for the base64-vs-raw size difference).
  const aResync = await a.syncNow();
  assert(
    aResync.summary.uploaded === 0,
    `A should not re-upload the unchanged image (uploaded=${aResync.summary.uploaded}, expected 0)`,
  );
}

// ── Sync data-safety scenarios (PKT-2: F1 / F3 / F9) ────────────

async function peerDeletesWhileDisconnected(a, b, server) {
  // F1: A creates + pushes a note, then disconnects (its .e2ee-state.json is
  // demoted to .e2ee-ancestry.json). B deletes the note (server tombstone).
  // A reconnects and syncs → the empty-map reconcile must HONOR the tombstone
  // and delete A's local copy, not drop the tombstone and re-POST the note
  // (which resurrected it fleet-wide, permanently).
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  await a.writeNote('doomed-note', '# Doomed');
  await a.syncNow();
  await b.syncNow();
  assert(await b.noteExists('doomed-note'), 'B should have the note before deleting');

  // A goes offline — demotes the live map to ancestry.
  await a.disconnectSync();

  // B deletes the note and pushes the tombstone.
  await b.deleteNoteInApp('doomed-note');
  await b.syncNow();
  assert(!(await b.noteExists('doomed-note')), 'B deleted the note');

  // A reconnects → object_map empty + max_version 0 → empty-map reconcile.
  await a.connectSync(server.url, server.password);
  await a.syncNow();
  assert(
    !(await a.noteExists('doomed-note')),
    'A must NOT resurrect a note the peer deleted while A was disconnected',
  );

  // And it must stay dead on B after another round-trip (proves A did not
  // re-POST it as a fresh object).
  await b.syncNow();
  assert(
    !(await b.noteExists('doomed-note')),
    'the deleted note must stay deleted on B (no resurrection)',
  );
}

async function editVsPeerDeletePreservesEdit(a, b, server) {
  // F3: A has a dirty local edit to a note that B deletes concurrently. A's
  // PUT 409s with a tombstone (current_blob_key: None). The edit must be
  // PRESERVED (re-POSTed as a fresh object), not silently discarded by the
  // pull's immediate-delete — symmetric with the edit-wins delete-conflict.
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  await a.writeNote('contested-edit', '# Original');
  await a.syncNow();
  await b.syncNow();
  assert(await b.noteExists('contested-edit'), 'B should have the note');

  // B deletes and pushes the tombstone first.
  await b.deleteNoteInApp('contested-edit');
  await b.syncNow();

  // A edits the note (dirty, unpushed) THEN syncs → PUT 409s on the tombstone.
  const editedBody = '# Original\n\nA edited this while B deleted it';
  await a.writeNote('contested-edit', editedBody);
  await a.syncNow();

  // A's edit must survive somewhere — nothing silently lost.
  assert(
    await a.noteExists('contested-edit'),
    "A's edited note must survive the concurrent peer delete",
  );
  assertEqual(
    await a.readNote('contested-edit'),
    editedBody,
    "A's local edit content must be preserved",
  );

  // The preserved edit propagates back to B (edit wins over the delete).
  await b.syncNow();
  assert(await b.noteExists('contested-edit'), "B should receive A's preserved edit");
  assertEqual(await b.readNote('contested-edit'), editedBody, "B should see A's edit content");
}

async function distinctSameBasenameSurvivesMoveDedup(a, b, server) {
  // F9: three distinct notes with identical content and the same basename
  // ("Untitled") in different folders. In one cycle A deletes one (a
  // same-content tombstone) and moves the other two to new folders (same
  // content, new paths). The concurrent-move dedup must key on OBJECT
  // IDENTITY — the two moved notes are distinct objects, not duplicates of the
  // deleted one — so BOTH must survive. Keying on (content-hash, basename)
  // deleted a real note here.
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  const body = '# Same content';
  await a.writeNote('W/Untitled', body);
  await a.writeNote('X/Untitled', body);
  await a.writeNote('Y/Untitled', body);
  await a.syncNow();
  await b.syncNow();
  assert(
    (await b.noteExists('X/Untitled')) && (await b.noteExists('Y/Untitled')),
    'B should have X and Y before the dedup cycle',
  );

  // One cycle: delete W (a same-content, same-basename tombstone) AND move
  // X, Y to new folders (PUT-reuse: same object, new path, unchanged content).
  await a.deleteNoteInApp('W/Untitled');
  await a.moveNote('X/Untitled', 'X2/Untitled');
  await a.moveNote('Y/Untitled', 'Y2/Untitled');
  await a.syncNow();

  // A's own push runs the dedup over its push writes — both moved notes must
  // survive on A.
  assert(await a.noteExists('X2/Untitled'), 'A must keep distinct note X2 (not dedup-deleted)');
  assert(await a.noteExists('Y2/Untitled'), 'A must keep distinct note Y2 (not dedup-deleted)');

  // B pulls the tombstone + both renames in one cycle → runs the dedup over
  // its pull writes. Both distinct notes must survive there too.
  await b.syncNow();
  assert(await b.noteExists('X2/Untitled'), 'B must keep distinct note X2 (not dedup-deleted)');
  assert(await b.noteExists('Y2/Untitled'), 'B must keep distinct note Y2 (not dedup-deleted)');
  assert(!(await b.noteExists('W/Untitled')), 'W stays deleted');
}

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
const ANDROID_MATRIX = 'desktop-android';

const ANDROID_SHARED_NOTE = `${HARNESS_NOTE_PREFIX}shared`;

async function androidReceivesDesktopNoteLive(desktop, android, server) {
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

async function desktopReceivesAndroidEditorEdit(desktop, android, server) {
  await desktop.connectSync(server.url, server.password);
  await android.connectSync(server.url, server.password);

  const base = '# shared\nbase text';
  await desktop.writeNote(ANDROID_SHARED_NOTE, base);
  await desktop.syncNow();
  await android.waitForNoteContent(ANDROID_SHARED_NOTE, base);

  // A real editor edit on the phone: the WebView posts the bridge `change`
  // message, the shell debounces a write, and NotesStore's mutation hook tells
  // Rust a local note changed so the live loop pushes it.
  const edited = '# shared\nedited in the Android editor';
  await android.editNoteViaEditor(ANDROID_SHARED_NOTE, edited);

  await waitForDesktopNoteContent(desktop, ANDROID_SHARED_NOTE, edited);
}

async function androidDefersFocusedPeerEditUntilBlur(desktop, android, server) {
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
async function androidKeepsADraftTypedWhileAPeerEditIsDeferred(desktop, android, server) {
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
  const localDraft = '# deferred draft\ntyped on the phone after the peer edit';
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

async function androidFollowsPeerRenameWhileOpen(desktop, android, server) {
  await desktop.connectSync(server.url, server.password);
  await android.connectSync(server.url, server.password);
  await desktop.pauseAutoSync();

  const oldId = `${HARNESS_NOTE_PREFIX}rename-open`;
  const newId = `${HARNESS_NOTE_PREFIX}renamed-open`;
  const base = '# rename while open\nbase text';
  await desktop.writeNote(oldId, base);
  await desktop.syncNow();
  await android.waitForNoteContent(oldId, base);

  await android.openNoteInEditor(oldId);
  await android.focusOpenEditor();

  await desktop.moveNote(oldId, newId);
  await desktop.syncNow();
  await android.waitForNoteMissing(oldId);
  await android.waitForNoteContent(newId, base);
  await android.waitForOpenEditorTitle(newId);
  await android.waitForOpenEditorContent(base);

  const editedAfterRename = '# rename while open\nedited after rename';
  await android.replaceOpenEditorContent(editedAfterRename);
  await android.waitForNoteContent(newId, editedAfterRename);
  assert(!android.noteExists(oldId), 'editing after a peer rename must not resurrect old id');

  await waitForDesktopNoteContent(desktop, newId, editedAfterRename);
  assert(!(await desktop.noteExists(oldId)), 'desktop should keep the old id deleted');
}

async function androidConflictsWithDesktopEdit(desktop, android, server) {
  await desktop.connectSync(server.url, server.password);
  await android.connectSync(server.url, server.password);

  const base = '# shared\nbase text';
  await desktop.writeNote(ANDROID_SHARED_NOTE, base);
  await desktop.syncNow();
  await android.waitForNoteContent(ANDROID_SHARED_NOTE, base);

  // The phone goes offline for real (airplane mode). Backgrounding alone is not
  // an offline window: an SSE pull already in flight lands after `pauseLive`, so
  // the phone fast-forwards to the desktop's version and edits on top of it —
  // there is no conflict left to resolve (observed).
  await android.goOffline();

  const androidText = '# shared\nedited on the phone while offline';
  await android.editNoteViaEditor(ANDROID_SHARED_NOTE, androidText);

  const desktopText = '# shared\ndesktop got there first';
  await desktop.writeNote(ANDROID_SHARED_NOTE, desktopText);
  await desktop.syncNow();

  // Back online, the phone's live loop reconnects on its own and runs a
  // push-first cycle: its offline edit loses the race, so it must survive as a
  // conflict copy instead of being overwritten.
  await android.goOnline();

  await android.waitForNoteContent(ANDROID_SHARED_NOTE, desktopText);
  const conflictId = await waitForAndroidConflictCopy(android, ANDROID_SHARED_NOTE, androidText);

  // Both clients converge on the same pair of notes.
  await waitForDesktopNoteContent(desktop, conflictId, androidText);
  await waitForDesktopNoteContent(desktop, ANDROID_SHARED_NOTE, desktopText);
}

/** Poll the desktop client for content the phone pushed. Each iteration runs a
 *  bounded sync rather than trusting a fixed settle window. */
async function waitForDesktopNoteContent(client, id, expected, timeoutMs = 90_000) {
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
async function waitForAndroidConflictCopy(android, id, expectedText, timeoutMs = 90_000) {
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

// ── Scenario registry ───────────────────────────────────────────

const scenarios = [
  { name: 'image sync roundtrip', fn: imageSyncRoundtrip, matrices: ['desktop-desktop'] },
  {
    name: 'editor roundtrip through real sync',
    fn: editorRoundtripThroughRealSync,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'edit during sync keeps local draft',
    fn: editDuringSyncKeepsLocalDraft,
    serverOptions: { syncDelayMs: 1500 },
    matrices: ['desktop-desktop'],
  },
  {
    name: 'dirty draft survives a peer edit then settles',
    fn: dirtyDraftSurvivesAPeerEditThenSettles,
    matrices: ['desktop-desktop'],
  },
  { name: 'concurrent edit conflict', fn: concurrentEditConflict, matrices: ['desktop-desktop'] },
  { name: 'three way merge', fn: threeWayMerge, matrices: ['desktop-desktop'] },
  { name: 'rename propagation', fn: renamePropagation, matrices: ['desktop-desktop'] },
  {
    name: 'collision placement follows open note',
    fn: collisionPlacementFollowsOpenNote,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'focused open note defers peer edit until blur',
    fn: focusedOpenNoteDefersPeerEditUntilBlur,
    matrices: ['desktop-desktop'],
  },
  // Folder-support v1 scenarios — see Specs § Sync conflict resolution.
  {
    name: 'folder rename on A edit on B',
    fn: folderRenameOnAEditOnB,
    matrices: ['desktop-desktop'],
  },
  { name: 'file move on A edit on B', fn: fileMoveOnAEditOnB, matrices: ['desktop-desktop'] },
  {
    name: 'file moved to two folders by A and B',
    fn: fileMovedToTwoFoldersByAandB,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'concurrent offline folder rename',
    fn: concurrentOfflineFolderRename,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'move note into folder delete folder',
    fn: moveNoteIntoFolderDeleteFolder,
    matrices: ['desktop-desktop'],
  },
  // Adversarial scenarios targeting pair_local_moved_objects edge cases.
  {
    name: 'local rename and edit in same sync',
    fn: localRenameAndEditInSameSync,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'multiple local moves in one sync',
    fn: multipleLocalMovesInOneSync,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'both clients rename to same destination',
    fn: bothClientsRenameToSameDestination,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'folder X and file X coexist at same level',
    fn: folderXVsFileXAtSameLevel,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'move into folder with existing filename suffixes',
    fn: moveIntoFolderWithExistingFilename,
    matrices: ['desktop-desktop'],
  },
  { name: 'empty folder does not sync', fn: emptyFolderDoesNotSync, matrices: ['desktop-desktop'] },
  {
    name: 'unportable name never syncs and is left alone',
    fn: unportableNameNeverSyncsAndIsLeftAlone,
    matrices: ['desktop-desktop'],
  },
  // TODO(justin): both external-watcher scenarios race under Docker/xvfb.
  // They swap which one hits the inotify delay run-to-run; one or the other
  // times out at 30s roughly half the time. Locally they pass in <2s, so
  // keep them enabled off-CI. Investigate separately — the notify crate's
  // event loop may be starved while the single-threaded xvfb renders, or
  // the CodeMirror update path may be blocked by unrelated IPC traffic.
  {
    name: 'external watcher reloads clean note',
    fn: externalWatcherReloadsCleanNote,
    matrices: ['desktop-desktop'],
    skipOnCi: true,
  },
  {
    name: 'external watcher protects dirty draft then settles',
    fn: externalWatcherProtectsDirtyDraftThenSettles,
    matrices: ['desktop-desktop'],
    skipOnCi: true,
  },
  { name: 'delete vs edit', fn: deleteVsEdit, matrices: ['desktop-desktop'] },
  {
    name: 'peer delete of open note closes editor',
    fn: peerDeleteOfOpenNoteClosesEditor,
    matrices: ['desktop-desktop'],
  },
  { name: 'lost state recovery', fn: lostStateRecovery, matrices: ['desktop-desktop'] },
  { name: 'rapid reconnect', fn: rapidReconnect, matrices: ['desktop-desktop'] },
  { name: 'offline accumulation', fn: offlineAccumulation, matrices: ['desktop-desktop'] },
  // slow: ~2 minutes of a ~4-minute scenario budget for a scale probe whose
  // mechanisms (upload, download, batching) cheap scenarios each cover.
  { name: 'large sync', fn: largeSync, matrices: ['desktop-desktop'], slow: true },
  {
    name: 'tombstone does not block new note',
    fn: tombstoneDoesNotBlockNewNote,
    matrices: ['desktop-desktop'],
  },
  // PKT-2 sync data-safety (F1 / F3 / F9).
  {
    name: 'peer deletes while disconnected',
    fn: peerDeletesWhileDisconnected,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'edit vs peer delete preserves edit',
    fn: editVsPeerDeletePreservesEdit,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'distinct same basename survives move dedup',
    fn: distinctSameBasenameSurvivesMoveDedup,
    matrices: ['desktop-desktop'],
  },
  // Native Android leg — runs whenever a usable device is reachable, and is
  // skipped LOUDLY otherwise (see runAndroidLeg).
  {
    name: 'android receives a desktop note live',
    fn: androidReceivesDesktopNoteLive,
    matrices: [ANDROID_MATRIX],
  },
  {
    name: 'desktop receives an android editor edit',
    fn: desktopReceivesAndroidEditorEdit,
    matrices: [ANDROID_MATRIX],
  },
  {
    name: 'android defers a focused peer edit until blur',
    fn: androidDefersFocusedPeerEditUntilBlur,
    matrices: [ANDROID_MATRIX],
  },
  {
    name: 'android keeps a draft typed while a peer edit is deferred',
    fn: androidKeepsADraftTypedWhileAPeerEditIsDeferred,
    matrices: [ANDROID_MATRIX],
  },
  {
    name: 'android follows a peer rename while open',
    fn: androidFollowsPeerRenameWhileOpen,
    matrices: [ANDROID_MATRIX],
  },
  {
    name: 'android conflicts with a desktop edit',
    fn: androidConflictsWithDesktopEdit,
    matrices: [ANDROID_MATRIX],
  },
];

// ── Main ────────────────────────────────────────────────────────

const managedStops = [];

const matrixLaunchers = {
  'desktop-desktop': {
    label: 'desktop ↔ desktop',
    // Launch sequentially so the Linux MCP bridge cannot race both processes
    // onto the same discovery port. Hook readiness is condition-polled, so
    // this no longer carries the old fixed five-second delay per client.
    // Register each stop as soon as its client is up: if client-b's startup
    // throws, exit-time cleanup must still terminate the running client-a.
    startClients: async () => {
      const clientA = await startDesktopTauriInstance('client-a', REPO_ROOT);
      managedStops.push(() => clientA.stop());
      const clientB = await startDesktopTauriInstance('client-b', REPO_ROOT);
      managedStops.push(() => clientB.stop());
      return [clientA, clientB];
    },
  },
};

function cleanup() {
  for (const stop of [...managedStops].reverse()) {
    try {
      stop();
    } catch {
      /* ignore */
    }
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));

// ── Bootstrap: ensure test-hook-enabled artifacts exist ────────
//
// The harness is meant to be run ad-hoc — user can invoke it regardless of
// whether the app is open, the server is up, or the emulator is running.
// We verify/rebuild artifacts here so a stale production build doesn't
// silently break test-hook detection.

function ensureDesktopDebugBinary() {
  const binPath = join(REPO_ROOT, 'target', 'debug', 'futo-notes-tauri');
  if (!existsSync(binPath)) {
    console.log('Desktop debug binary missing — building with test hooks…');
    rebuildDesktopBinary();
    return;
  }
  // If dist/ lacks __testSync, the last `cargo tauri build` (or any
  // `npm run build`) produced a hooks-free bundle. Rebuild — the Rust
  // codegen embeds whatever dist/ currently contains.
  if (!distHasTestHooks()) {
    console.log('dist/ was built without VITE_INCLUDE_TEST_HOOKS — rebuilding desktop binary…');
    rebuildDesktopBinary();
    return;
  }
  // Provenance check: `cargo tauri dev` (and plain `cargo build`) write the
  // SAME target/debug/futo-notes-tauri path, but bake a dev config into it —
  // a dev-server devUrl and a per-worktree identifier. Launched by this
  // harness, such a binary loads its UI from a live vite dev server and
  // shares the WebKit data container with any running dev instance, which
  // silently corrupts scenarios (empty notes dirs, no-op syncs). Rebuild
  // whenever the binary on disk is not the one rebuildDesktopBinary() last
  // produced.
  const stamp = join(REPO_ROOT, 'target', 'debug', '.harness-binary-stamp');
  const binMtime = String(statSync(binPath).mtimeMs);
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== binMtime) {
    console.log(
      'Desktop binary was rebuilt outside the harness (likely `cargo tauri dev`) — rebuilding with harness config…',
    );
    rebuildDesktopBinary();
    return;
  }
  // Staleness: none of the checks above look at the SOURCE, so a second run in
  // the same checkout happily reported a verdict for the previous run's binary.
  // That cost a #89 fix a false red (fix applied, mesh re-run, identical
  // failures, `bootstrap 19ms`) and would just as easily hand out a false green
  // — the M11 failure class, one build behind. Rebuild whenever anything the
  // binary embeds is newer than the binary itself.
  const newestSource = newestSourceMtime();
  if (newestSource > statSync(binPath).mtimeMs) {
    console.log('Sources are newer than the desktop binary — rebuilding so the run tests them…');
    rebuildDesktopBinary();
  }
}

// Newest mtime across everything baked into the harness binary: the webview app
// and editor package (through dist/), the Rust workspace, and the desktop
// shell's own sources and configuration. Build outputs and dependencies are
// skipped — they are derived, and walking them would dominate the cost.
function newestSourceMtime() {
  const SKIP = new Set(['node_modules', 'target', 'dist', '.git', 'build', '.build']);
  let newest = 0;
  const visit = (path) => {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (!SKIP.has(entry)) visit(join(path, entry));
      }
      return;
    }
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
  };
  for (const rel of [
    'src',
    'packages',
    'crates',
    'apps/tauri',
    'index.html',
    'editor.html',
    'package.json',
    'vite.config.ts',
    'Cargo.toml',
    'Cargo.lock',
  ]) {
    visit(join(REPO_ROOT, rel));
  }
  return newest;
}

function rebuildDesktopBinary() {
  // cargo clean -p so the tauri build script re-runs and re-embeds dist/ with
  // the test hooks: a futo-notes-tauri crate cached from a build without
  // VITE_INCLUDE_TEST_HOOKS can otherwise re-link a hooks-free binary. This
  // guard lived in the CI job script; it belongs here so every rebuild —
  // local or CI — gets it, and CI doesn't pay for a second identical build.
  runOrThrow('cargo', ['clean', '-p', 'futo-notes-tauri'], {
    cwd: join(REPO_ROOT, 'apps', 'tauri'),
  });
  runOrThrow('cargo', ['tauri', 'build', '--debug', '--no-bundle'], {
    cwd: join(REPO_ROOT, 'apps', 'tauri'),
    env: { ...process.env, VITE_INCLUDE_TEST_HOOKS: 'true' },
  });
  const binPath = join(REPO_ROOT, 'target', 'debug', 'futo-notes-tauri');
  writeFileSync(
    join(REPO_ROOT, 'target', 'debug', '.harness-binary-stamp'),
    String(statSync(binPath).mtimeMs),
  );
}

// Scan every emitted chunk, not `index-*.js`[0]: a build emits a dozen
// `index-<hash>.js` chunks and only ONE carries __testSync, so reading the
// alphabetically-first one almost always concluded "built without test hooks"
// and charged the run a `cargo clean -p` plus a full relink it did not need
// (papercut pc_b1be12680b61). vite empties dist/ per build, so nothing here can
// be a leftover from an older hooks-enabled bundle.
function distHasTestHooks() {
  const assetsDir = join(REPO_ROOT, 'dist', 'assets');
  if (!existsSync(assetsDir)) return false;
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .some((name) => fileContains(join(assetsDir, name), '__testSync'));
}

function fileContains(path, needle) {
  try {
    return readFileSync(path, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

function runOrThrow(cmd, argv, opts) {
  const res = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${argv.join(' ')} failed with exit ${res.status}`);
  }
}

function killStaleClients() {
  // A leftover debug binary from an interrupted run holds an MCP port; clear it
  // so the harness boots cleanly every time. It used to also SIGTERM whatever
  // held port 5181 (a vite preview this harness no longer starts) — a
  // machine-wide kill of an unidentified stranger, which is another worktree's
  // process as easily as our own.
  // Only kill debug binaries spawned with the multi-instance flag — that's
  // how the harness launches them, so this won't touch a user's open app.
  const ps = spawnSync('pgrep', ['-af', 'futo-notes-tauri'], { encoding: 'utf8' });
  const lines = (ps.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const [_, pidStr, cmdline] = match;
    // Only kill binaries from this repo's target/debug — a conservative check
    // that excludes the user's installed FUTO Notes.
    if (cmdline.includes(`${REPO_ROOT}/target/debug/futo-notes-tauri`)) {
      try {
        process.kill(Number(pidStr), 'SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }
}

/** Run a list of scenarios against one client pair: fresh server per scenario,
 *  both clients reset in between, one result row each. */
async function runScenarios(list, clientA, clientB) {
  for (const scenario of list) {
    // main's slot-derived port band, not a bare counter: a hardcoded start had
    // every worktree allocating the same port, so a second run adopted the
    // first's server and database.
    const port = allocateServerPort();
    const serverSetupStartedAt = Date.now();
    const server = await startServer(port, REPO_ROOT, scenario.serverOptions ?? {});
    const serverSetupMs = Date.now() - serverSetupStartedAt;
    timings.serverSetupMs += serverSetupMs;
    managedStops.push(() => server.stop());

    const caseStartedAt = Date.now();
    let clientResetMs = 0;
    let scenarioMs = 0;
    try {
      // Reset clients between scenarios
      const clientResetStartedAt = Date.now();
      await clientA.reset();
      await clientB.reset();
      clientResetMs = Date.now() - clientResetStartedAt;
      timings.clientResetMs += clientResetMs;

      const scenarioStartedAt = Date.now();
      try {
        await scenario.fn(clientA, clientB, server);
      } finally {
        scenarioMs = Date.now() - scenarioStartedAt;
        timings.scenarioMs += scenarioMs;
      }

      const ms = Date.now() - caseStartedAt;
      results.push({
        name: scenario.name,
        pass: true,
        ms,
        serverSetupMs,
        clientResetMs,
        scenarioMs,
      });
      console.log(`  ✓ ${scenario.name} (${ms}ms)`);
    } catch (err) {
      const ms = Date.now() - caseStartedAt;
      results.push({
        name: scenario.name,
        pass: false,
        ms,
        serverSetupMs,
        clientResetMs,
        scenarioMs,
        error: err.message,
      });
      console.log(`  ✗ ${scenario.name} (${ms}ms)`);
      console.log(`    ${err.message}`);
    } finally {
      server.stop();
    }
  }
}

/**
 * Attach the native Android leg when a usable device is reachable.
 *
 * On a developer machine with no device attached, no device is a legitimate
 * state, so it skips — but never quietly: the banner says the mesh ran
 * desktop-only and every skipped scenario carries its reason into the report.
 * A device that IS available and then fails to start is a red failure, not a
 * skip (AGENTS.md M11).
 *
 * Under `--android-only` the device is the entire point of the run (the
 * dedicated CI job boots an emulator for it), so an unusable device fails red
 * instead of skipping.
 */
async function runAndroidLeg(androidScenarios, desktopClient) {
  if (androidScenarios.length === 0) return;

  const device = args['no-android']
    ? { available: false, reason: '--no-android was passed' }
    : findAndroidLegDevice();

  if (!device.available && args['android-only']) {
    console.log('');
    console.log(`  ✗ --android-only requires a usable device: ${device.reason}`);
    for (const scenario of androidScenarios) {
      results.push({
        name: scenario.name,
        pass: false,
        ms: 0,
        error: `no usable Android device: ${device.reason}`,
      });
    }
    return;
  }

  if (!device.available) {
    console.log('');
    console.log('='.repeat(72));
    console.log('SKIP: no Android device — running desktop-only mesh');
    console.log(`  reason: ${device.reason}`);
    console.log('  to include it: just qa-claim android && just android-native');
    console.log(`  skipped: ${androidScenarios.map((s) => s.name).join(', ')}`);
    console.log('='.repeat(72));
    for (const scenario of androidScenarios) {
      results.push({
        name: scenario.name,
        skip: true,
        reason: `no Android device: ${device.reason}`,
      });
    }
    return;
  }

  console.log(`\nStarting native Android client on ${device.serial}...`);
  let android;
  try {
    const startedAt = Date.now();
    android = await startAndroidNativeInstance('client-android', REPO_ROOT, device.serial);
    timings.clientStartupMs += Date.now() - startedAt;
    managedStops.push(() => android.stop());
    console.log(`  Client Android ready (${android.platform}, vault ${android.vaultPath})\n`);
  } catch (err) {
    // The device was there; failing to drive it is a real failure.
    console.log(`  ✗ native Android client failed to start: ${err.message}`);
    for (const scenario of androidScenarios) {
      results.push({
        name: scenario.name,
        pass: false,
        ms: 0,
        error: `android startup: ${err.message}`,
      });
    }
    return;
  }

  await runScenarios(androidScenarios, desktopClient, android);
  android.stop();
}

async function main() {
  console.log('Cross-platform sync integration tests\n');

  const matrix = matrixLaunchers[args.matrix];
  if (!matrix) {
    throw new Error(
      `Unknown matrix "${args.matrix}". Expected one of: ${Object.keys(matrixLaunchers).join(', ')}`,
    );
  }
  console.log(`Matrix: ${matrix.label}\n`);

  // Bootstrap artifacts and clean up stale state from a prior run.
  const bootstrapStartedAt = Date.now();
  killStalePreviewAndClients();
  ensureDesktopDebugBinary();
  timings.bootstrapMs = Date.now() - bootstrapStartedAt;

  // Filter scenarios if --scenario is set
  const selected = args.scenario
    ? scenarios.filter((s) => s.name.toLowerCase().includes(args.scenario.toLowerCase()))
    : scenarios;

  if (selected.length === 0) {
    console.error(`No scenarios matching "${args.scenario}"`);
    process.exit(1);
  }

  const toRun = [];
  const androidLegScenarios = [];
  for (const scenario of selected) {
    if (args['android-only'] && !scenario.matrices.includes(ANDROID_MATRIX)) {
      // Not "skipped" — out of scope for this run, and reporting 31 skip rows
      // would bury the 5 that matter. The desktop mesh has its own job.
      continue;
    }
    if (scenario.matrices.includes(ANDROID_MATRIX)) {
      // Availability is decided later, after the desktop mesh has run, so a
      // missing or broken device can never delay or fail the desktop suite.
      androidLegScenarios.push(scenario);
    } else if (!scenario.matrices.includes(args.matrix)) {
      results.push({
        name: scenario.name,
        skip: true,
        reason: `not included in matrix ${args.matrix}`,
      });
      console.log(`  - ${scenario.name} (skipped: not included in matrix ${args.matrix})`);
    } else if (scenario.skipOnCi && process.env.CI) {
      results.push({ name: scenario.name, skip: true, reason: 'skipOnCi' });
      console.log(`  - ${scenario.name} (skipped: flaky on CI — see scenario registry TODO)`);
    } else if (scenario.slow && args['skip-slow']) {
      results.push({ name: scenario.name, skip: true, reason: 'slow (--skip-slow)' });
      console.log(`  - ${scenario.name} (skipped: slow — runs on main/tag pipelines)`);
    } else {
      toRun.push(scenario);
    }
  }

  if (toRun.length === 0 && androidLegScenarios.length === 0) {
    throw new Error(`No runnable scenarios for matrix ${args.matrix}`);
  }

  // ── Suite setup: start 2 Tauri instances (done once) ──────────
  console.log('\nStarting Tauri instances...');

  const clientStartupStartedAt = Date.now();
  // startClients registers each client's stop in managedStops as it comes up.
  const [clientA, clientB] = await matrix.startClients();
  timings.clientStartupMs = Date.now() - clientStartupStartedAt;
  console.log(`  Client A ready (${clientA.platform}, MCP port ${clientA.port ?? 'n/a'})`);
  console.log(`  Client B ready (${clientB.platform}, MCP port ${clientB.port ?? 'n/a'})`);

  console.log('');

  await runScenarios(toRun, clientA, clientB);
  // The Android leg pairs the phone with client A; client B is started either
  // way because launching the pair is the matrix launcher's contract, and an
  // idle second instance is cheaper than a second launcher shape.
  await runAndroidLeg(androidLegScenarios, clientA);

  // ── Report ────────────────────────────────────────────────────
  console.log('');
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => r.pass === false).length;
  const skipped = results.filter((r) => r.skip).length;
  const totalRun = passed + failed;
  console.log(`Results: ${passed}/${totalRun} passed, ${failed} failed, ${skipped} skipped`);
  const totalMs = Date.now() - suiteStartedAt;
  console.log(
    `Phases: bootstrap ${timings.bootstrapMs}ms, clients ${timings.clientStartupMs}ms, ` +
      `servers ${timings.serverSetupMs}ms, resets ${timings.clientResetMs}ms, ` +
      `scenarios ${timings.scenarioMs}ms, total ${totalMs}ms`,
  );

  // Write JSON report
  const reportDir = 'test-screenshots';
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(reportDir, 'sync-results.json'),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        matrix: args['android-only'] ? ANDROID_MATRIX : args.matrix,
        timings: { ...timings, totalMs },
        results,
      },
      null,
      2,
    ),
  );

  // ── Teardown ──────────────────────────────────────────────────
  clientA.stop();
  clientB.stop();

  // Explicit exit: WebSocket + child-process handles from the Tauri/emulator
  // clients can linger past stop() (TCP CLOSE_WAIT, SIGTERM grace) and keep
  // the Node event loop alive indefinitely — GitLab then waits for the job
  // timeout instead of noticing tests already passed.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

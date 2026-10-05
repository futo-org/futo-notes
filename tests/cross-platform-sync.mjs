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
 *   - E2EE sync server:    downloaded on first use (the release pinned in
 *                          scripts/sync-server-pin.json); no checkout needed
 *   - Frontend built with: VITE_INCLUDE_TEST_HOOKS=true pnpm run build
 *   - Android leg only:    a booted device/emulator with the debug app
 *                          (just qa-claim android && just android-native)
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { restartDesktopTauriInstance, startDesktopTauriInstance } from './lib/tauri-instance.mjs';
import {
  HARNESS_NOTE_PREFIX,
  findAndroidLegDevice,
  startAndroidNativeInstance,
} from './lib/android-native-instance.mjs';
import { startServer } from './lib/sync-test-server.mjs';
import { fillQuota, lapseSubscription, setQuota } from './lib/standin-browser.mjs';
import { standinModeAvailable } from '../scripts/lib/sync-server.mjs';
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
  let last;
  while (Date.now() - start < timeoutMs) {
    const state = await client.getOpenNoteState();
    last = state.editorContent;
    if (state.editorContent === expectedContent) return state;
    await sleep(100);
  }
  throw new Error(
    `${client.name}: editor content did not become ${JSON.stringify(expectedContent)} after ${timeoutMs}ms ` +
      `(last seen: ${JSON.stringify(last)})`,
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
  // What the harness types, and what the editor writes for it. Milkdown
  // re-serializes the whole note on a real edit, so composed markdown reaches
  // the editor buffer and the file in its serialized spelling: a blank line
  // between blocks and one trailing newline (ADR-0002 normalize-once,
  // docs/spec/editor.md "WYSIWYG rendering"). Typing source and asserting the
  // same bytes back was the CodeMirror editor's byte passthrough.
  const typed = '# Written in Milkdown\nThis note should sync through the real save pipeline.';
  const body = '# Written in Milkdown\n\nThis note should sync through the real save pipeline.\n';

  // A creates a new note through the actual editor path, with the note still
  // living ONLY in the editor buffer when the sync is requested: body + title +
  // syncNow() all happen in one page task, so no debounce or blur flush can
  // persist it first (the harness owns the ordering instead of racing it).
  await a.openNewNote();
  const composed = await a.composeNoteAndSyncNow(noteId, typed);
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

async function backlinkRewritePropagation(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  await a.writeNote('recieve', 'body');
  await a.writeNote('hub', 'see [[recieve]]');
  await a.syncNow();
  await b.syncNow();
  assert(
    (await b.readNote('hub')).includes('[[recieve]]'),
    'B should start out holding the misspelled link',
  );

  // Same length on purpose: the rewritten hub keeps both its mtime and its size.
  await a.moveNote('recieve', 'receive');
  await a.syncNow();
  await b.syncNow();

  const hub = await b.readNote('hub');
  assert(hub.includes('[[receive]]'), `B's hub must follow the rewrite, got: ${hub}`);
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

async function collisionNameUsesFullObjectIdentity(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  await a.writeNote('old/shared', 'older object');
  await a.syncNow();
  await b.syncNow();
  await b.writeNote('shared', 'later object');
  await b.syncNow();
  await a.moveNote('old/shared', 'shared');
  await a.syncNow();
  await b.syncNow();

  const bFiles = (await b.listNotes()).map((file) => file.filename || file.name || file);
  const copy = bFiles.find((name) => /^shared \(conflict [0-9a-f]{32}\)\.md$/.test(name));
  assert(copy, `collision copy should carry all UUID bits, got ${JSON.stringify(bFiles)}`);
  assertEqual(await b.readNote('shared'), 'older object', 'winner body');
  assertEqual(await b.readNote(copy.replace(/\.md$/, '')), 'later object', 'loser body');
  await a.syncNow();
  const aFiles = (await a.listNotes()).map((file) => file.filename || file.name || file);
  assert(aFiles.includes(copy), 'both clients should converge on the same collision name');
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
  // '# Clean note\n': the editor composed this note, so the file holds its
  // serialized spelling with a trailing newline (ADR-0002 normalize-once), and
  // reopening hands those same bytes back. Only the EXTERNAL content below is
  // adopted verbatim.
  await waitForEditorContent(a, '# Clean note\n');
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

async function externalAtomicSaveOntoTheOpenNoteIsAdopted(a, _b, _server) {
  // An external editor's atomic save writes a temp file and renames it onto
  // the note. Through a temp with a note's name (mkstemp with a `.md` suffix)
  // the watcher reports a rename ONTO the open note; through a hidden temp,
  // Linux inotify reports an add of it. Either one replaced the open note's
  // bytes, so the clean editor adopts them like an in-place write.
  await a.openNewNote();
  await a.setTitle('watch atomic');
  await a.typeInEditor('# Before the save');
  await a.flushSave();
  await a.waitForOpenNote('watch atomic');
  await a.openNote('watch atomic');
  await waitForEditorContent(a, '# Before the save\n');
  await waitForToastClear(a);
  await sleep(1200);

  for (const [temp, content] of [
    ['tmpk3j2v9.md', '# Saved through a note-named temp'],
    ['.watch atomic.md.tmp123', '# Saved through a hidden temp'],
  ]) {
    await a.externalAtomicSaveNote('watch atomic', content, temp);
    const state = await waitForEditorContent(a, content, 30_000);
    assertEqual(
      state.originalId,
      'watch atomic',
      `the save through ${temp} should keep the same note open`,
    );
    await sleep(1200);
  }
  const files = (await a.listNotes()).map((f) => f.filename || f.name || f);
  assert(
    !files.some((name) => name.includes('tmpk3j2v9') || name.includes('conflict')),
    `an atomic save must leave only the note, got: ${files.join(', ')}`,
  );
  assertEqual(await a.readNote('watch atomic'), '# Saved through a hidden temp');
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
  // Trailing newline for the same reason as in externalWatcherReloadsCleanNote:
  // the editor composed and saved this note (ADR-0002 normalize-once).
  await waitForEditorContent(a, '# Original content\n');

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
  // instead of B's edit — the same contended-convergence hazard the
  // folder/move rows (FOLDER_MOVE_CASES) pause auto-sync to avoid. Pausing
  // here changes nothing about the conflict tested (A deletes, B edits, both
  // from the shared baseline); it only makes the stated sync ordering real.
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

async function selfHostedBearerStaysOutOfVault(a, _b, server) {
  await a.connectSync(server.url, server.password);
  const statePath = join(a.notesDir, '.app-state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert(!Object.hasOwn(state, 'e2eeAuthToken'), 'vault app state must not carry the bearer token');
  await a.syncNow();
  await a.disconnectSync();
}

async function rapidReconnect(a, _b, server) {
  // Connect and disconnect 3 times (server rate limits /login to 5/min).
  for (let i = 0; i < 3; i++) {
    try {
      await a.connectSync(server.url, server.password);
    } catch (err) {
      throw new Error(`Connect failed on iteration ${i} (server ${server.url}): ${err.message}`, {
        cause: err,
      });
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

// The two-client folder/move convergence rows share one shape, so they are one
// table walked by one runner (runFolderMoveCase). Each row still registers as
// its own scenario under its own name, so a failure names the case.
//
// Shape of every row: both clients connect and PAUSE auto-sync, A writes
// `seed` and syncs, B syncs and must see every seeded note, then A performs
// its `a` steps and B its `b` steps with no sync in between (both offline
// relative to each other), then the explicit `syncs` run in order and the
// `expect` block is asserted.
//
// Why both clients pause: convergence in every row depends on the exact
// explicit a→b(→a) sync ordering. With either live loop up, a move
// (delete+create) or edit auto-pushes at an uncontrolled time and the peer's
// live loop auto-pulls out of order — stranding an edit on a deleted path,
// leaving a transient duplicate, reordering the last write that LWW converges
// to, or splitting a batch that pair_local_moved_objects must see in ONE push
// (flakes on MR !64 and !66 run-1). Pausing makes the explicit syncs the sole
// driver; it changes nothing about the conflict each row sets up.
//
// Steps are [verb, ...args]: write(id, body) · delete(id) · move(from, to) ·
// mkdir(path) · rmdir(path). `expect.files` is the exact sorted note-id set on
// BOTH clients; `expect.content` maps id → body on BOTH clients;
// `expect.eitherHas` is the weaker "at least one client has it" check.
const FOLDER_MOVE_CASES = [
  {
    // Spec row: folder rename on A + note edit inside on B → both apply. Either
    // the rename or the edit lands; the other applies on top via LWW. Asserted:
    // no orphaned content (the renamed path exists somewhere).
    name: 'folder rename on A edit on B',
    seed: { 'Specs/folder-support': '# Folders' },
    a: [
      ['delete', 'Specs/folder-support'],
      ['write', 'Specs/folders/folder-support', '# Folders'],
    ],
    b: [['write', 'Specs/folder-support', '# Folders\n\nNew section from B']],
    syncs: 'aba',
    expect: { eitherHas: 'Specs/folders/folder-support' },
  },
  {
    // Spec row: file move to folder on A + edit on B → both apply; the peer
    // edit lands on the moved path only.
    name: 'file move on A edit on B',
    seed: { grocery: '# Grocery' },
    a: [
      ['delete', 'grocery'],
      ['write', 'Lists/grocery', '# Grocery'],
    ],
    b: [['write', 'grocery', '# Grocery\nupdated']],
    syncs: 'aba',
    expect: {
      files: ['Lists/grocery'],
      content: { 'Lists/grocery': '# Grocery\nupdated' },
    },
  },
  {
    // Spec row: same file moved to two different folders by A and B →
    // last-write-wins; both converge on B's (later) destination.
    name: 'file moved to two folders by A and B',
    seed: { contested: '# Original' },
    a: [
      ['delete', 'contested'],
      ['write', 'FolderA/contested', '# Original'],
    ],
    b: [
      ['delete', 'contested'],
      ['write', 'FolderB/contested', '# Original'],
    ],
    syncs: 'aba',
    expect: { files: ['FolderB/contested'] },
  },
  {
    // Both clients move the same notes to different new folders; convergence is
    // to the later server write.
    name: 'concurrent offline folder rename',
    seed: { 'Specs/alpha': '# Alpha', 'Specs/beta': '# Beta' },
    a: [
      ['mkdir', 'Docs'],
      ['move', 'Specs/alpha', 'Docs/alpha'],
      ['move', 'Specs/beta', 'Docs/beta'],
    ],
    b: [
      ['mkdir', 'Archive'],
      ['move', 'Specs/alpha', 'Archive/alpha'],
      ['move', 'Specs/beta', 'Archive/beta'],
    ],
    syncs: 'aba',
    expect: { files: ['Archive/alpha', 'Archive/beta'] },
  },
  {
    // A moves a note into X while B creates-then-deletes X and edits the note:
    // one moved path carrying the merged edit.
    name: 'move note into folder delete folder',
    seed: { 'draft-note-01': '# Draft' },
    a: [
      ['mkdir', 'X'],
      ['move', 'draft-note-01', 'X/draft-note-01'],
    ],
    b: [
      ['mkdir', 'X'],
      ['rmdir', 'X'],
      ['write', 'draft-note-01', '# Draft\n\nedited while X was deleted'],
    ],
    syncs: 'aba',
    expect: {
      files: ['X/draft-note-01'],
      content: { 'X/draft-note-01': '# Draft\n\nedited while X was deleted' },
    },
  },
  // Adversarial rows targeting pair_local_moved_objects edge cases.
  {
    // One client renames AND edits before syncing: the rename must collapse
    // into a single PUT at the new filename (object_id preserved) carrying the
    // edit — not a DELETE + POST that tombstones the object.
    name: 'local rename and edit in same sync',
    seed: { grocery: '# Grocery' },
    a: [
      ['delete', 'grocery'],
      ['write', 'Lists/grocery', '# Grocery\n\nMilk, eggs, bread'],
    ],
    b: [],
    syncs: 'ab',
    expect: {
      files: ['Lists/grocery'],
      content: { 'Lists/grocery': '# Grocery\n\nMilk, eggs, bread' },
    },
  },
  {
    // One client moves THREE notes before syncing: each pairs independently by
    // basename, and B's pull sees three in-place renames, not tombstone+create.
    name: 'multiple local moves in one sync',
    seed: { apple: '# Apple', banana: '# Banana', cherry: '# Cherry' },
    a: [
      ['delete', 'apple'],
      ['write', 'Fruit/apple', '# Apple'],
      ['delete', 'banana'],
      ['write', 'Fruit/banana', '# Banana'],
      ['delete', 'cherry'],
      ['write', 'Fruit/cherry', '# Cherry'],
    ],
    b: [],
    syncs: 'ab',
    expect: { files: ['Fruit/apple', 'Fruit/banana', 'Fruit/cherry'] },
  },
  {
    // Both clients make the SAME rename. The second PUT 409s,
    // resolve_update_conflict sees remote.path == its own filename, 3-way
    // merges cleanly (identical content) and converges without a copy.
    name: 'both clients rename to same destination',
    seed: { shared: '# Shared' },
    a: [
      ['delete', 'shared'],
      ['write', 'Docs/shared', '# Shared'],
    ],
    b: [
      ['delete', 'shared'],
      ['write', 'Docs/shared', '# Shared'],
    ],
    syncs: 'aba',
    expect: { files: ['Docs/shared'], content: { 'Docs/shared': '# Shared' } },
  },
];

const FOLDER_MOVE_STEPS = {
  write: (client, id, body) => client.writeNote(id, body),
  delete: (client, id) => client.deleteNote(id),
  move: (client, from, to) => client.moveNote(from, to),
  mkdir: (client, path) => client.createFolder(path),
  rmdir: (client, path) => client.deleteFolder(path),
};

async function listNoteIds(client) {
  return (await client.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
}

async function runFolderMoveCase(row, a, b, server) {
  const clients = { a, b };
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  for (const [id, body] of Object.entries(row.seed)) await a.writeNote(id, body);
  await a.syncNow();
  await b.syncNow();
  for (const id of Object.keys(row.seed)) {
    assert(await b.noteExists(id), `B should see seeded note ${id} before the offline edits`);
  }

  for (const side of ['a', 'b']) {
    for (const [verb, ...stepArgs] of row[side]) {
      await FOLDER_MOVE_STEPS[verb](clients[side], ...stepArgs);
    }
  }
  for (const side of row.syncs) await clients[side].syncNow();

  const { files, content = {}, eitherHas } = row.expect;
  if (eitherHas) {
    const has = (await a.noteExists(eitherHas)) || (await b.noteExists(eitherHas));
    assert(has, `one client should have ${eitherHas}`);
  }
  for (const [label, client] of [
    ['A', a],
    ['B', b],
  ]) {
    if (files) {
      assertEqual(
        JSON.stringify(await listNoteIds(client)),
        JSON.stringify(files),
        `${label} should converge to exactly these note paths`,
      );
    }
    for (const [id, body] of Object.entries(content)) {
      assertEqual(await client.readNote(id), body, `${label} content of ${id}`);
    }
  }
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

async function overdeepLocalPathIsReportedBeforeUpload(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  const overdeep = `${'folder/'.repeat(11)}note`;
  mkdirSync(join(a.notesDir, 'folder/'.repeat(11)), { recursive: true });
  await a.externalWriteNote(overdeep, '# Too deep');
  await a.writeNote('portable control', '# Control note');

  const pushed = await a.syncNow();
  const failures = pushed?.summary?.failures ?? [];
  assert(
    failures.some(
      (failure) => failure.filename === `${overdeep}.md` && failure.kind === 'rejected',
    ),
    `sender must report the path peers reject: ${JSON.stringify(failures)}`,
  );
  const received = await b.syncNow();
  assert(await b.noteExists('portable control'), 'a valid neighbour must still sync');
  assert(!(await b.noteExists(overdeep)), 'the rejected path must never reach a peer');
  assert(
    !received?.summary?.failures?.length,
    'the receiver should have no rejected-path failure because it was never uploaded',
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
  const edited = '# shared\n\nedited in the Android editor\n';
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

// RC-08 (FB-5): the open-note verdict must see an edit the editor has not
// reported yet. A large note withholds `change` while its tail streams, so the
// shell's copy — which the verdict used to be taken on — still equals the base
// after the user typed and dismissed the keyboard. A peer edit then classified
// as a clean Adopt and `applyExternalContent` discarded the edit; a peer delete
// classified as Close. The shell now reads the editor before it classifies.
//
// Outcome-based on purpose: whether the engine answers KeepDraft (the read
// answered) or nothing at all (the read ran out of its deadline while the
// renderer finished the tail — then the released `change` reaches the ordinary
// save, whose flush verb parks it), the typed text must survive and so must
// the peer's.
const UNREPORTED_EDIT_SECTIONS = 20_000;

function streamingSizedNote(title) {
  const sections = Array.from(
    { length: UNREPORTED_EDIT_SECTIONS },
    (_, i) => `## Section ${i}\n\nBody line ${i} of a note long enough to stream.`,
  );
  return `# ${title}\n\n${sections.join('\n\n')}\n`;
}

/** Open `id`, type `marker` while its tail is still streaming, and prove the
 *  focused edit is still unreported when this returns. Blur now flushes it. */
async function typeUnreportedEditWhileStreaming(android, id, base, marker) {
  await android.openNoteInEditor(id);
  await android.focusOpenEditor();
  await android.typeIntoOpenEditor(marker);
  // M11: the window this scenario exists for. A stream that already finished
  // released the `change`, and the verdict below would pass for the wrong
  // reason — raise UNREPORTED_EDIT_SECTIONS rather than accept that.
  assert(
    await android.isOpenEditorStreaming(),
    'the note finished streaming before the peer change could land — the edit is ' +
      'already reported, so this run proves nothing',
  );
  assertEqual(android.readNote(id), base, 'the typed edit must not have been saved yet');
}

/** Every harness note in the Android vault holding `text`, by id. */
function androidNotesContaining(android, text) {
  return android
    .listNoteFilenames()
    .filter((name) => name.startsWith(HARNESS_NOTE_PREFIX))
    .map((name) => name.replace(/\.md$/, ''))
    .filter((candidate) => (android.readNote(candidate) ?? '').includes(text));
}

async function waitForAndroidNoteContaining(android, text, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hits = androidNotesContaining(android, text);
    if (hits.length > 0) return hits;
    await sleep(1_000);
  }
  throw new Error(
    `${android.name}: no note holds ${JSON.stringify(text)} — the unreported edit was discarded ` +
      `(notes: ${JSON.stringify(android.listNoteFilenames())})`,
  );
}

async function androidKeepsAnUnreportedEditOverAPeerEdit(desktop, android, server) {
  await desktop.connectSync(server.url, server.password);
  await android.connectSync(server.url, server.password);
  await desktop.pauseAutoSync();

  const id = `${HARNESS_NOTE_PREFIX}unreported-edit`;
  const base = streamingSizedNote('unreported edit');
  await desktop.writeNote(id, base);
  await desktop.syncNow();
  await android.waitForNoteContent(id, base);

  const marker = 'TYPEDWHILESTREAMING ';
  await typeUnreportedEditWhileStreaming(android, id, base, marker);

  const peerEdit = base.replace('Body line 1 of', 'Body line 1 (peer edit) of');
  await desktop.writeNote(id, peerEdit);
  await desktop.syncNow();

  await waitForAndroidNoteContaining(android, marker);
  await waitForAndroidNoteContaining(android, '(peer edit)');
}

async function androidKeepsAnUnreportedEditOverAPeerDelete(desktop, android, server) {
  await desktop.connectSync(server.url, server.password);
  await android.connectSync(server.url, server.password);
  await desktop.pauseAutoSync();

  const id = `${HARNESS_NOTE_PREFIX}unreported-delete`;
  const base = streamingSizedNote('unreported delete');
  await desktop.writeNote(id, base);
  await desktop.syncNow();
  await android.waitForNoteContent(id, base);

  const marker = 'TYPEDBEFOREPEERDELETE ';
  await typeUnreportedEditWhileStreaming(android, id, base, marker);

  await desktop.deleteNoteInApp(id);
  await desktop.syncNow();

  // Persist-or-park: the draft stays open and its save recreates the note.
  await waitForAndroidNoteContaining(android, marker);
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

  const editedAfterRename = '# rename while open\n\nedited after rename\n';
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

  const androidText = '# shared\n\nedited on the phone while offline\n';
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

// ── Hosted sync (Log in with FUTO) ──────────────────────────────
//
// These drive the REAL desktop app through the whole hosted flow against a
// server in stand-in test mode: sign in through the Login Hand-off, pay through
// the stand-in payment provider, create or unlock the vault, and reach a first
// sync. The parent spec's user stories are the acceptance test; each scenario
// below names the ones it covers.
//
// Two things stand in for hardware that a test process does not have, and
// neither hides a step:
//   - the BROWSER is this process (tests/lib/standin-browser.mjs). The app
//     publishes the URL it would have opened and keeps polling the server; the
//     driver fetches it with a cookie jar, and the app's own wait completes.
//   - the CAMERA is a string. `showPairingCode` hands the payload up as text and
//     the other instance is given that text, which is exactly what a scanner
//     would have produced — decision 5's relay round trip is otherwise real.
//
// They need two things that CI does not have: a server that carries stand-in
// mode (see standinModeAvailable() and the skip in main()), and an OS secret
// store, because the desktop keeps the vault key and the session token in the
// keyring and nowhere else.

const HOSTED_VAULT_PASSWORD = 'a long enough vault password';
/** The one identity a stand-in login produces (server ADR 0009). */
const HOSTED_EMAIL = 'person@standin.test';

/** Runs the wizard on [client] against this scenario's stand-in server. */
function hostedConnect(client, server, options = {}) {
  return client.connectHosted({
    serverUrl: server.url,
    vaultPassword: HOSTED_VAULT_PASSWORD,
    ...options,
  });
}

/**
 * Seven groups of four: 27 Crockford base32 data characters and one check
 * character (ADR 0003 decision 6; the alphabets are in `recovery_key.rs`).
 *
 * Crockford's data alphabet leaves out I, L, O and U so a handwritten key
 * cannot be misread; the check character has its own longer alphabet, which
 * puts U and four punctuation marks back — so the last character is matched
 * separately, not by the data pattern. A key that came back unformatted, or
 * empty, is one a person cannot write down or type back.
 *
 * Asserted as a shape rather than a value: the key is 128 bits of entropy and
 * differs every run.
 */
const CROCKFORD_DATA = '[0-9A-HJKMNP-TV-Z]';
const CROCKFORD_CHECK = '[0-9A-HJKMNP-TV-Z*~$=U]';
const RECOVERY_KEY_SHAPE = new RegExp(
  `^(${CROCKFORD_DATA}{4}-){6}${CROCKFORD_DATA}{3}${CROCKFORD_CHECK}$`,
);

function assertRecoveryKeyShape(key, who) {
  assert(typeof key === 'string', `${who}: no recovery key was produced`);
  assert(
    RECOVERY_KEY_SHAPE.test(key),
    `${who}: recovery key is not 27 Crockford characters plus a check character, ` +
      `in seven groups of four: ${JSON.stringify(key)}`,
  );
}

/** Polls until a note's content arrives on [client], syncing each time. */
async function waitForSyncedNote(client, id, expected, timeoutMs = 60_000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await client.readNote(id).catch(() => null);
    if (last === expected) return;
    await client.syncNow().catch(() => {});
    await sleep(500);
  }
  throw new Error(
    `${client.name}: ${id} never arrived (last: ${JSON.stringify(last)}, wanted ${JSON.stringify(expected)})`,
  );
}

/**
 * How a manual sync was refused, by HTTP status rather than by sentence.
 *
 * A 402 and a 507 come back inside the cycle's `failures` — the cycle itself
 * reports success — so "did it throw" is not the question. The status code is a
 * protocol fact and safe to assert on; the message is UI copy and is not (M15).
 */
async function syncRefusal(client) {
  try {
    const result = await client.syncNow();
    const failures = result?.summary?.failures ?? [];
    return {
      refused: failures.length > 0,
      statuses: failures.map((failure) => failure.statusCode),
      // The engine's own reading of those statuses, which is what every shell
      // renders a banner from (futo_notes_sync::WriteRefusal).
      writeRefusal: result?.summary?.writeRefusal ?? null,
      detail: JSON.stringify(failures),
    };
  } catch (error) {
    return { refused: true, statuses: [], writeRefusal: null, detail: error.message };
  }
}

/**
 * Fails if [id] ever reaches [client]. Proof that a refused write stayed put.
 *
 * Asks whether the file exists rather than reading it: the local store answers
 * a missing note with an empty string, so a `readNote(...) === null` check here
 * never fires and would have passed whatever the server did.
 */
async function assertNeverArrives(client, id, forMs = 4_000) {
  const start = Date.now();
  while (Date.now() - start < forMs) {
    await client.syncNow().catch(() => {});
    const arrived = await client.noteExists(id).catch(() => false);
    assert(!arrived, `${client.name}: ${id} arrived, but the write should have been refused`);
    await sleep(500);
  }
}

/**
 * Stories 6, 7, 8, 10, 22 and 24: a brand-new account subscribes, chooses a
 * vault password, is shown a recovery key once, and reaches a first sync.
 */
async function hostedNoVaultShapeReachesAFirstSync(a, _b, server) {
  const account = await hostedConnect(a, server);

  assertEqual(account.step, 'ready', 'the wizard should finish on the account card');
  assertEqual(account.email, HOSTED_EMAIL, 'the account card names who is signed in');
  assert(account.billing?.entitled === true, 'the account may write after checkout');
  assertEqual(account.banner, 'none', 'a paid-up account with room shows no banner');

  const progress = await a.hostedProgress();
  assertEqual(
    progress.opened.length,
    2,
    `a fresh account opens the browser twice — sign-in then checkout (opened ${progress.opened.length})`,
  );
  assertRecoveryKeyShape(progress.recoveryKey, a.name);

  // The wizard exists to reach a sync, so the proof is a note on the server.
  const noteId = 'hosted first sync';
  const body = '# Hosted\nThe wizard finished and this went up.';
  await a.writeNote(noteId, body);
  const summary = await a.syncNow();
  assertEqual(
    summary.summary.failures.length,
    0,
    `the first hosted sync reported failures: ${JSON.stringify(summary.summary.failures)}`,
  );
  assert(
    summary.status.appState.lastSyncedAt !== null,
    'the first hosted sync never completed a cycle',
  );
  assertEqual(summary.status.appState.lastSyncError, '', 'the first hosted sync reported an error');
}

/**
 * Stories 12 and 20: a second device signs in, finds a vault already there, and
 * unlocks it by typing the vault password — no subscribe step, no recovery key.
 */
async function hostedVaultExistsUnlocksByVaultPassword(a, b, server) {
  await hostedConnect(a, server);
  const noteId = 'hosted by password';
  const body = '# By password\nTyped on the first device.';
  await a.writeNote(noteId, body);
  await a.syncNow();

  const account = await hostedConnect(b, server);
  assertEqual(account.step, 'ready', 'the second device should reach the account card');

  const progress = await b.hostedProgress();
  assertEqual(
    progress.opened.length,
    1,
    `a vault that exists skips subscribe — only sign-in opens a browser (opened ${JSON.stringify(progress.opened)})`,
  );
  assertEqual(
    progress.recoveryKey,
    null,
    'the recovery key is shown on a fresh vault only, never on an unlock',
  );

  await waitForSyncedNote(b, noteId, body);
}

/**
 * Stories 17 and 18: a device with nothing but the recovery key gets in — typed
 * the way a person retypes one, in lower case with the dashes left out.
 */
async function hostedVaultExistsUnlocksByRecoveryKey(a, b, server) {
  await hostedConnect(a, server);
  const recoveryKey = (await a.hostedProgress()).recoveryKey;
  assertRecoveryKeyShape(recoveryKey, a.name);

  const noteId = 'hosted by recovery key';
  const body = '# By recovery key\nTyped on the first device.';
  await a.writeNote(noteId, body);
  await a.syncNow();

  const account = await hostedConnect(b, server, {
    door: 'recoveryKey',
    // No vault password at all: the door must not quietly fall back to one.
    vaultPassword: undefined,
    recoveryKey: recoveryKey.toLowerCase().replaceAll('-', ''),
  });
  assertEqual(account.step, 'ready', 'the recovery key should unlock the vault');

  await waitForSyncedNote(b, noteId, body);
}

/**
 * Stories 13, 14 and 16: the device being set up shows a code, the unlocked one
 * reads it and confirms, and the key travels over the relay. The scanned string
 * is passed between the two instances in place of a camera.
 */
async function hostedPairingBetweenTwoDesktopInstances(a, b, server) {
  await hostedConnect(a, server);
  const noteId = 'hosted by pairing';
  const body = '# By pairing\nTyped on the unlocked device.';
  await a.writeNote(noteId, body);
  await a.syncNow();

  // B signs in and stops at the unlock screen — signed in, still locked, which
  // is where a person stands while holding the code up to their phone.
  const locked = await hostedConnect(b, server, { stopAtStep: 'unlock' });
  assertEqual(locked.step, 'unlock', 'the second device should be signed in and locked');

  await b.startShowPairingCode();
  const payload = await b.waitForPairingPayload();
  assert(payload.includes('futo_notes_pairing'), `not a pairing payload: ${payload.slice(0, 120)}`);

  // The confirmation sheet's content, on the unlocked device. Nothing has been
  // sent at this point; acceptPairing reads the code and only then confirms.
  const shown = await a.acceptPairing(payload);
  assert(
    typeof shown.deviceName === 'string' && shown.deviceName.length > 0,
    'the confirmation sheet must name the device it is about to hand a key to',
  );
  assertEqual(shown.platform, 'desktop', 'a laptop pairing to a laptop reports desktop');

  const account = await b.awaitShowPairingCode();
  assertEqual(account.step, 'ready', 'the paired device should reach the account card');

  await waitForSyncedNote(b, noteId, body);
}

/**
 * Stories 27 and 28: a lapsed subscription pauses writes and says so, while the
 * other device's notes keep arriving.
 */
async function hostedLapsedSubscriptionPausesWritesAndKeepsReads(a, b, server) {
  await hostedConnect(a, server);
  await hostedConnect(b, server);

  const arriving = 'hosted lapsed arrival';
  const arrivingBody = '# Pushed before the lapse\nThis still has to reach the other device.';
  await a.writeNote(arriving, arrivingBody);
  await a.syncNow();

  const token = await a.hostedSessionToken();
  assert(Boolean(token), 'the signed-in device should hold a session token');
  await lapseSubscription(server.url, token);

  // The read. A lapsed card must never strand a device.
  await waitForSyncedNote(b, arriving, arrivingBody);

  // The write. Refused with the subscription's own status, and it stays put.
  const blocked = 'hosted lapsed write';
  await b.writeNote(blocked, '# Written after the lapse\n');
  const refusal = await syncRefusal(b);
  assert(refusal.refused, `a lapsed account should not be able to push: ${refusal.detail}`);
  assert(
    refusal.statuses.includes(402),
    `the refusal should be 402 subscription_required: ${refusal.detail}`,
  );

  // Before anybody opens the account screen. The engine named the refusal, so
  // the banner is already earned — nothing here has read billing since the
  // lapse (ADR 0003 decision 8; docs/spec/sync.md).
  assertEqual(
    refusal.writeRefusal,
    'subscriptionRequired',
    'the cycle itself should report the refusal, not just a status code',
  );
  const onTheSpot = await b.hostedRefusalBanner();
  assertEqual(
    onTheSpot.banner,
    'syncPaused',
    'the Sync paused banner must be up the moment the refused cycle ends',
  );

  await assertNeverArrives(a, blocked);

  const account = await b.hostedAccount();
  assertEqual(account.banner, 'syncPaused', 'a lapsed subscription raises the Sync paused banner');
  assert(account.billing?.entitled === false, 'billing should report the account cannot write');
}

/** Story 29: a full vault says so, and stops saying so when there is room. */
async function hostedFullVaultRaisesTheVaultFullBanner(a, _b, server) {
  await hostedConnect(a, server);

  // Something must already be stored: filling the quota drops the ceiling to
  // what the account holds, and a ceiling of zero reads as "unknown", not full.
  await a.writeNote('hosted quota', '# Stored\nSo the vault has a size to be full of.');
  await a.syncNow();

  const token = await a.hostedSessionToken();
  await fillQuota(server.url, token);

  const full = await a.hostedAccount();
  assertEqual(full.banner, 'vaultFull', 'a full vault raises the Vault is full banner');
  assert(
    full.billing.bytesUsed >= full.billing.storageQuotaBytes && full.billing.storageQuotaBytes > 0,
    `the quota was not actually filled: ${JSON.stringify(full.billing)}`,
  );

  const blocked = 'hosted quota second';
  await a.writeNote(blocked, '# One byte too many\n');
  const refusal = await syncRefusal(a);
  assert(refusal.refused, `a full vault should refuse the next write: ${refusal.detail}`);
  assert(
    refusal.statuses.includes(507),
    `the refusal should be 507 quota_exceeded: ${refusal.detail}`,
  );

  // Before anybody opens the account screen, and with no billing call in
  // between: the refused cycle earned the banner on its own.
  assertEqual(
    refusal.writeRefusal,
    'quotaExceeded',
    'the cycle itself should report the refusal, not just a status code',
  );
  const onTheSpot = await a.hostedRefusalBanner();
  assertEqual(
    onTheSpot.banner,
    'vaultFull',
    'the Vault is full banner must be up the moment the refused cycle ends',
  );

  // The banner is a live reading of the account, not a latch: buy room and it
  // goes away without anything being reset.
  await setQuota(server.url, token, 64 * 1024 * 1024);
  const cleared = await syncRefusal(a);
  assertEqual(
    cleared.writeRefusal,
    null,
    'a cycle that was not refused must clear the refusal it carries',
  );
  assertEqual(
    (await a.hostedRefusalBanner()).banner,
    'none',
    'room on the plan should clear the banner without anything being reset',
  );
  const roomy = await a.hostedAccount();
  assertEqual(roomy.banner, 'none', 'room on the plan should clear the banner');
}

/** Story 30: sign out revokes the session and forgets the key. The notes stay. */
async function hostedSignOutKeepsTheNotesOnDisk(a, _b, server) {
  await hostedConnect(a, server);

  const noteId = 'hosted sign out';
  const body = '# Mine\nThese notes are on this disk and stay there.';
  await a.writeNote(noteId, body);
  await a.syncNow();

  await a.hostedSignOut();

  const after = await a.hostedAccount();
  assertEqual(after.step, 'signIn', 'signing out puts the wizard back at its first screen');
  assertEqual(after.email, '', 'nobody is signed in after a sign out');

  assertEqual(await a.readNote(noteId), body, 'signing out must not touch the notes');
  const files = await a.listNotes();
  assert(
    files.some((file) => file.name === `${noteId}.md`),
    `the note file should still be on disk: ${JSON.stringify(files.map((file) => file.name))}`,
  );

  // And the device really is signed out: a sync has no session to run with.
  const refusal = await syncRefusal(a);
  assert(refusal.refused, `a signed-out device should not sync: ${refusal.detail}`);
}

/**
 * Waits for a note to arrive on a client that NOTHING is driving.
 *
 * The other waiters call `syncNow()` each pass, which is the opposite of what
 * this proves: the point is that the restarted app connected its hosted
 * session and started cycling on its own. So the only calls here are reads —
 * the sync status hook and the note itself. `lastSyncedAt` must also move past
 * the value the previous process left on disk, or a note that was already
 * there before the restart would pass this.
 */
async function waitForLaunchSync(client, id, expected, since, timeoutMs = 90_000) {
  const start = Date.now();
  let lastSyncedAt = since;
  let body = null;
  while (Date.now() - start < timeoutMs) {
    const status = await client.syncStatus().catch(() => null);
    lastSyncedAt = status?.appState?.lastSyncedAt ?? lastSyncedAt;
    body = await client.readNote(id).catch(() => null);
    if (body === expected && lastSyncedAt !== since) return;
    await sleep(1_000);
  }
  throw new Error(
    `${client.name}: the relaunched app never synced on its own ` +
      `(lastSyncedAt ${JSON.stringify(since)} → ${JSON.stringify(lastSyncedAt)}, ` +
      `${id} last read as ${JSON.stringify(body)}, wanted ${JSON.stringify(expected)})`,
  );
}

/**
 * C2 / story 27: a hosted device that is quit and reopened syncs at launch.
 *
 * Deliberately touches NO hosted hook after the restart. `hostedAccount()` and
 * `connectHosted()` both connect the session themselves, so either one would
 * re-create the Settings visit this exists to remove and the scenario would
 * pass on a build that never resumes at boot. B is left completely alone: the
 * proof is a cycle it ran and a note it fetched by itself.
 */
async function hostedRestartSyncsAtLaunchWithoutOpeningSettings(a, b, server) {
  await hostedConnect(a, server);
  await hostedConnect(b, server);

  // A baseline both devices agree on, so the restart starts from a real
  // synced state rather than an empty one.
  const before = 'hosted before the restart';
  const beforeBody = '# Before\nBoth devices have this.';
  await a.writeNote(before, beforeBody);
  await a.syncNow();
  await waitForSyncedNote(b, before, beforeBody);
  const lastSyncedAt = (await b.syncStatus()).appState.lastSyncedAt;
  assert(lastSyncedAt !== null, 'B should have completed a cycle before it is restarted');

  // Quit and reopen B. The new process has no hosted session in memory; the
  // vault key and the session token are in the OS secret store, and only the
  // boot credential load can hand them back to the engine.
  await restartDesktopTauriInstance(b, REPO_ROOT, { env: { FUTO_HOSTED_SERVER: server.url } });

  const noteId = 'hosted after the restart';
  const body = '# After\nWritten on the other device while this one was closed.';
  await a.writeNote(noteId, body);
  await a.syncNow();

  await waitForLaunchSync(b, noteId, body, lastSyncedAt);

  // Nothing is asserted past here. `forgetHosted()` — how the suite drops a
  // device's hosted secrets between scenarios — is a no-op until something has
  // told the test hook which server this device is on, and the relaunched
  // process has never been told. Say it now, so a restart cannot leak a
  // signed-in vault into whatever runs next.
  await hostedConnect(b, server);
}

async function conflictCopiesOf(client, title) {
  const files = (await client.listNotes()).map((file) =>
    String(file.filename || file.name || file),
  );
  return files.filter((name) => name.startsWith(`${title} (conflict`));
}

async function focusedTypistAfterDeferredPeerEditMintsOneCopy(a, b, server) {
  // One peer edit is one conflict. A focused reader defers the peer's edit
  // (the adopt would move the caret), then keeps typing in pauses longer than
  // the body debounce. The first save parks the draft as a conflict copy; every
  // later save must be an ordinary save of the same continuing edit. The editor
  // follows the copy and advances its baseline to the parked draft (the native
  // shells' rule, editor.md), so it never re-parks against the peer's bytes at
  // the note's own id. Leaving the baseline behind minted a copy per pause (3
  // pauses, 3 copies) and the typed words existed only across those copies.
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  await a.pauseAutoSync();
  await b.pauseAutoSync();
  await a.writeNote('focused typist', '# Base');
  await a.syncNow();
  await b.syncNow();
  await b.openNote('focused typist');
  await waitForEditorContent(b, '# Base');
  await b.focusEditor();

  await a.writeNote('focused typist', '# Base\nPeer edit');
  await a.syncNow();
  const pulled = await b.syncNow();
  assertEqual(pulled.summary.downloaded, 1, `B downloaded=${pulled.summary.downloaded}`);
  assertEqual(
    (await b.getOpenNoteState()).editorContent,
    '# Base',
    'a focused editor defers the peer edit',
  );

  for (const word of ['alpha', 'bravo', 'charlie']) {
    await b.typeInEditor(` ${word}`);
    await sleep(1500);
  }
  await waitForSaveIdle(b);
  const copies = await conflictCopiesOf(b, 'focused typist');
  console.log(`    [focused typist] copies after one peer edit: ${JSON.stringify(copies)}`);
  assertEqual(copies.length, 1, `one conflict must mint ONE copy, got ${JSON.stringify(copies)}`);
  const copyId = copies[0].replace(/\.md$/, '');
  const copyBody = await b.readNote(copyId);
  for (const word of ['alpha', 'bravo', 'charlie']) {
    assert(copyBody.includes(word), `the copy must hold every typed word, got ${copyBody}`);
  }
  assertEqual(
    await b.readNote('focused typist'),
    '# Base\nPeer edit',
    "the peer's bytes stay at the note's own id",
  );
  const state = await b.getOpenNoteState();
  assertEqual(state.originalId, copyId, 'the editor follows the parked copy');

  // Leaving the editor settles nothing new: no adopt over the typist's text,
  // no further copy.
  await b.blurEditor();
  await sleep(500);
  await waitForSaveIdle(b);
  assertEqual((await b.getOpenNoteState()).originalId, copyId, 'blur keeps the editor on the copy');
  assertEqual((await conflictCopiesOf(b, 'focused typist')).length, 1, 'blur mints no copy');

  await b.syncNow();
  await a.syncNow();
  const aCopies = await conflictCopiesOf(a, 'focused typist');
  assertEqual(aCopies.length, 1, `the peer receives ONE copy, got ${JSON.stringify(aCopies)}`);
  assertEqual(await a.readNote(copyId), copyBody, 'the peer receives the continuing edit');
}

async function peerRenameWhileSavePendingLeavesNoGhost(a, b, server) {
  // A pending body save must follow a reported rename of the open note before
  // it persists. Flushing it first addressed it to the pre-rename id, whose
  // file sync had just moved away, so the store recreated the note there: a
  // ghost that synced to every device, and the renamed note then parked a
  // conflict copy on the next edit (sync.md: the editor never stays bound to
  // the id the note left). Pauses of ~300 ms keep the 500 ms body debounce
  // armed when the completion lands; back-to-back typing stays inside the
  // editor's own 200 ms change debounce and never arms it.
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  await a.pauseAutoSync();
  await b.pauseAutoSync();
  await a.writeNote('peer renames', '# Plan');
  await a.syncNow();
  await b.syncNow();
  await b.openNote('peer renames');
  await waitForEditorContent(b, '# Plan');

  await a.moveNote('peer renames', 'peer renamed');
  await a.syncNow();

  await b.startSync();
  let stop = false;
  let typed = 0;
  const typing = (async () => {
    while (!stop && typed < 400) {
      await b.typeInEditor(` r${typed}`);
      typed += 1;
      await sleep(300);
    }
  })();
  const pulled = await b.awaitStartedSync();
  const atCompletion = await b.getOpenNoteState();
  stop = true;
  await typing;
  console.log(
    `    [peer rename] renamed=${JSON.stringify(pulled.summary.renamed)} typed=${typed} ` +
      `atCompletion open=${atCompletion.originalId} savePending=${atCompletion.savePending}`,
  );
  await sleep(1000);
  await b.flushSave();
  await waitForSaveIdle(b);
  const state = await b.getOpenNoteState();
  const ghost = await b.noteExists('peer renames');
  const copies = await conflictCopiesOf(b, 'peer renamed');
  console.log(
    `    [peer rename] open=${state.originalId} ghostAtOldId=${ghost} copies=${JSON.stringify(copies)}`,
  );
  assert(!ghost, 'a pending save recreated the note at the id the peer renamed away from');
  assertEqual(copies.length, 0, `no conflict copies expected, got ${JSON.stringify(copies)}`);
  assertEqual(state.originalId, 'peer renamed', 'the editor follows the rename');
  const renamedBody = await b.readNote('peer renamed');
  assert(
    renamedBody.includes(`r${typed - 1}`),
    `the typing lands in the renamed note: disk ${JSON.stringify(renamedBody)}, ` +
      `editor ${JSON.stringify(state.editorContent)}`,
  );

  await b.syncNow();
  await a.syncNow();
  assert(!(await a.noteExists('peer renames')), 'no ghost reaches the peer');
}

async function tabTitles(client) {
  return client.readWebview(
    `[...document.querySelectorAll('.tab-pill .tab-title')].map((e) => e.textContent.trim())`,
    'tab titles',
  );
}

/** Press a shell shortcut (primary = Cmd on macOS, Ctrl elsewhere), typing
 * `text` first in the SAME page task when given, so the switch's own flush is
 * the first save of that typing. */
async function pressShellShortcut(client, shortcut, text = null) {
  return client._executeMutation(
    `(() => {
      const mac = /Mac|iPhone|iPad/i.test(navigator.userAgent);
      const { primary, ...init } = ${JSON.stringify(shortcut)};
      if (primary) Object.assign(init, mac ? { metaKey: true } : { ctrlKey: true });
      const text = ${JSON.stringify(text)};
      if (text !== null) window.__notesShellTest.typeInEditor(text);
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
      return true;
    })()`,
    'shell shortcut',
  );
}

async function switchWhoseFlushParks(a, b, variant) {
  const id = `switch park ${variant}`;
  const other = `switch park ${variant} other`;
  await a.writeNote(other, '# Other');
  await a.writeNote(id, '# Base');
  await a.syncNow();
  await b.syncNow();

  // new tab: [.., id] -> Ctrl+T -> a Home tab.
  // close tab: [.., other, id] -> Ctrl+W -> other.
  // next tab: [.., id, other] with id active -> Ctrl+Tab -> other.
  let shortcut;
  await b.openNote(variant === 'close tab' ? other : id);
  if (variant === 'new tab') {
    shortcut = { key: 't', primary: true };
  } else {
    await waitForEditorContent(b, variant === 'next tab' ? '# Base' : '# Other');
    await pressShellShortcut(b, { key: 't', primary: true });
    await waitForOpenNoteState(b, 'open a new tab', (state) => state.originalId === null);
    await b.openNote(variant === 'next tab' ? other : id);
    if (variant === 'next tab') {
      await waitForEditorContent(b, '# Other');
      await pressShellShortcut(b, { key: 'Tab', ctrlKey: true, shiftKey: true });
      shortcut = { key: 'Tab', ctrlKey: true };
    } else {
      shortcut = { key: 'w', primary: true };
    }
  }
  await waitForEditorContent(b, '# Base');
  await b.focusEditor();

  await a.writeNote(id, '# Base\nPeer edit');
  await a.syncNow();
  const pulled = await b.syncNow();
  assertEqual(pulled.summary.downloaded, 1, `[${variant}] B downloaded`);
  assertEqual(
    (await b.getOpenNoteState()).editorContent,
    '# Base',
    `[${variant}] a focused editor defers the peer edit`,
  );
  const tabsBefore = await tabTitles(b);

  await pressShellShortcut(b, shortcut, ' zulu');
  const expectedOpen = variant === 'new tab' ? null : other;
  const arrived = await waitForOpenNoteState(
    b,
    `[${variant}] complete the switch to ${JSON.stringify(expectedOpen)}`,
    (state) => state.originalId === expectedOpen,
  );
  await waitForSaveIdle(b);
  await sleep(1000); // a late re-park would land in this window
  const tabsAfter = await tabTitles(b);
  const copies = await conflictCopiesOf(b, id);
  console.log(
    `    [${variant}] open=${JSON.stringify(arrived.originalId)} tabs ${JSON.stringify(tabsBefore)} -> ` +
      `${JSON.stringify(tabsAfter)} copies=${JSON.stringify(copies)}`,
  );

  assert(
    !tabsAfter.some((title) => title.includes('(conflict')),
    `[${variant}] no tab may be retargeted to the copy: ${JSON.stringify(tabsAfter)}`,
  );
  if (variant === 'new tab') {
    assertEqual(tabsAfter.length, tabsBefore.length + 1, `[${variant}] one tab opens`);
    for (const title of tabsBefore) {
      assert(
        tabsAfter.includes(title),
        `[${variant}] tab ${title} survives: ${JSON.stringify(tabsAfter)}`,
      );
    }
  } else {
    const expectedTabs = [...tabsBefore];
    if (variant === 'close tab') expectedTabs.splice(expectedTabs.lastIndexOf(id), 1);
    assertEqual(JSON.stringify(tabsAfter), JSON.stringify(expectedTabs), `[${variant}] tab strip`);
  }
  assertEqual(
    copies.length,
    1,
    `[${variant}] one conflict mints ONE copy: ${JSON.stringify(copies)}`,
  );
  const copyBody = await b.readNote(copies[0].replace(/\.md$/, ''));
  assert(copyBody.includes('zulu'), `[${variant}] the copy holds the typed word: ${copyBody}`);
  assertEqual(await b.readNote(id), '# Base\nPeer edit', `[${variant}] peer bytes at the id`);
}

async function parkInsideAKeyboardSwitchLeavesTheSwitchAlone(a, b, server) {
  // The first save after a deferred peer edit parks the draft as a conflict
  // copy. When that save is the flush of a keyboard note switch (the editor
  // keeps DOM focus through Ctrl+T / Ctrl+W / Ctrl+Tab), the tab store has
  // already moved to the destination. Following the copy there retargeted the
  // DESTINATION tab: the new tab showed the copy, the closed tab's neighbour
  // was rewritten to the copy, Ctrl+Tab rewrote the tab it landed on. The
  // user is leaving the note, so the switch completes untouched and the copy
  // is only listed (editor.md, desktop parked disposition).
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  // Each variant reports on its own, so one failure does not hide the others.
  const failures = [];
  for (const variant of ['new tab', 'close tab', 'next tab']) {
    try {
      await switchWhoseFlushParks(a, b, variant);
    } catch (error) {
      console.log(`    [${variant}] FAIL ${error.message}`);
      failures.push(`[${variant}] ${error.message}`);
    }
  }
  assertEqual(failures.length, 0, `switch variants failed: ${failures.join(' | ')}`);
}

/** Rename a sidebar row the way a user does: double-click it, replace the
 * inline field's text, press Enter. Synthetic DOM events in the webview only. */
async function renameSidebarRow(client, rowSelector, inputTestId, value) {
  return client._executeMutation(
    `(async () => {
      const row = document.querySelector(${JSON.stringify(rowSelector)});
      if (!row) throw new Error('sidebar row not found: ' + ${JSON.stringify(rowSelector)});
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      const selector = '[data-testid="${inputTestId}"]';
      let input = null;
      for (let i = 0; i < 100 && !input; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        input = document.querySelector(selector);
      }
      if (!(input instanceof HTMLInputElement)) throw new Error('rename field did not open');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      for (let i = 0; i < 250 && document.querySelector(selector); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (document.querySelector(selector)) throw new Error('rename field did not close');
      return true;
    })()`,
    'renameSidebarRow',
  );
}

async function relinkOfTheOpenNote(b, variant) {
  const tag = variant.replace(/[^a-z]+/g, '');
  const hub = `relink hub ${tag}`;
  let before;
  let after;
  let rename;
  if (variant === 'note rename') {
    const target = `relink target ${tag}`;
    before = `see [[${target}]] here`;
    after = `see [[${target} moved]] here`;
    await b._executeMutation(
      `window.__testNotes.createNote(${JSON.stringify(target)}, 'target body')`,
      'createNote',
    );
    rename = () =>
      renameSidebarRow(
        b,
        `button.note-row[data-note-id=${JSON.stringify(target)}]`,
        'note-rename-input',
        `${target} moved`,
      );
  } else if (variant === 'folder rename') {
    // The open note is OUTSIDE the renamed folder; only its link points in.
    before = `see [[relinkbox${tag}/relink filed]] here`;
    after = `see [[relinkcrate${tag}/relink filed]] here`;
    await b._executeMutation(
      `window.__testNotes.createNote(${JSON.stringify(`relinkbox${tag}/relink filed`)}, 'filed')`,
      'createNote',
    );
    rename = () =>
      renameSidebarRow(
        b,
        `[data-folder-path=${JSON.stringify(`relinkbox${tag}`)}]`,
        'folder-rename-input',
        `relinkcrate${tag}`,
      );
  } else if (variant === 'projected move') {
    // A move that only projects (no save lock): the app's own moveNote.
    const mover = `relink mover ${tag}`;
    before = `see [[${mover}]] here`;
    after = `see [[relinkdest${tag}/${mover}]] here`;
    await b._executeMutation(
      `window.__testNotes.createNote(${JSON.stringify(mover)}, 'mover')`,
      'createNote',
    );
    rename = () =>
      b._executeMutation(
        `window.__testNotes.moveNoteWithCollisions(${JSON.stringify(mover)}, ${JSON.stringify(`relinkdest${tag}/${mover}`)})`,
        'moveNoteWithCollisions',
      );
  } else {
    throw new Error(`unknown variant ${variant}`);
  }
  await b._executeMutation(
    `window.__testNotes.createNote(${JSON.stringify(hub)}, ${JSON.stringify(before)})`,
    'createNote',
  );
  await b.openNote(hub);
  await waitForEditorContent(b, before);

  await rename();
  const onDisk = await b.readNote(hub);
  assertEqual(onDisk, after, `[${variant}] the rename relinks the open note on disk`);
  let adopted = false;
  for (let i = 0; i < 30 && !adopted; i += 1) {
    adopted = (await b.getOpenNoteState()).editorContent === after;
    if (!adopted) await sleep(100);
  }
  await b.focusEditor();
  await b.typeInEditor(' typed word');
  await b.flushSave();
  await waitForSaveIdle(b);
  await sleep(500);
  const copies = await conflictCopiesOf(b, hub);
  const saved = await b.readNote(hub);
  console.log(
    `    [${variant}] adopted=${adopted} disk=${JSON.stringify(saved)} copies=${JSON.stringify(copies)}`,
  );
  assertEqual(copies.length, 0, `[${variant}] a relink minted ${JSON.stringify(copies)}`);
  assert(saved.includes('typed word'), `[${variant}] the typed word must land in the note`);
  assert(saved.includes(after.slice(4, -5)), `[${variant}] the rewritten link survives the save`);
  assert(adopted, `[${variant}] the editor shows the rewritten link before the user types`);
  assertEqual(
    (await b.getOpenNoteState()).originalId,
    hub,
    `[${variant}] the editor stays on the note`,
  );
}

async function titleRenameRelinkingItsOwnLink(b) {
  // The editor's own title rename rewrites the note's self-link after writing
  // the draft; the session recorded the draft it sent as its baseline.
  const journal = 'relink journal';
  const diary = 'relink diary';
  await b._executeMutation(
    `window.__testNotes.createNote(${JSON.stringify(journal)}, ${JSON.stringify(`back to [[${journal}]]`)})`,
    'createNote',
  );
  await b.openNote(journal);
  await waitForEditorContent(b, `back to [[${journal}]]`);
  await b.focusEditor();
  await b.setTitle(diary);
  await b.flushSave();
  await waitForOpenNoteState(b, 'follow the title rename', (state) => state.originalId === diary);
  assertEqual(await b.readNote(diary), `back to [[${diary}]]`, 'the rename relinks the self-link');
  let adopted = false;
  for (let i = 0; i < 30 && !adopted; i += 1) {
    adopted = (await b.getOpenNoteState()).editorContent === `back to [[${diary}]]`;
    if (!adopted) await sleep(100);
  }
  await b.typeInEditor(' typed word');
  await b.flushSave();
  await waitForSaveIdle(b);
  await sleep(500);
  const copies = await conflictCopiesOf(b, diary);
  const saved = await b.readNote(diary);
  console.log(
    `    [self link] adopted=${adopted} disk=${JSON.stringify(saved)} copies=${JSON.stringify(copies)}`,
  );
  assertEqual(copies.length, 0, `[self link] a title rename minted ${JSON.stringify(copies)}`);
  assert(saved.includes('typed word'), '[self link] the typed word must land in the note');
  assert(saved.includes(`[[${diary}]]`), '[self link] the rewritten self-link survives the save');
  assert(adopted, '[self link] the editor shows the rewritten self-link');
}

async function renameRelinkingTheOpenNoteDoesNotPark(_a, b) {
  // Renaming a note the open note links to — or a folder it links into, or
  // the open note itself when it links to itself — rewrites the open note's
  // file behind the editor (the store suppresses the watcher for its own
  // writes). The editor kept its pre-rename baseline, so the next keystroke's
  // save parked "<note> (conflict D)" for a conflict nobody made and the typed
  // word was missing from the note. The open note adopts the rewritten file.
  const failures = [];
  for (const variant of ['note rename', 'folder rename', 'projected move', 'self link']) {
    try {
      if (variant === 'self link') await titleRenameRelinkingItsOwnLink(b);
      else await relinkOfTheOpenNote(b, variant);
    } catch (error) {
      console.log(`    [${variant}] FAIL ${error.message}`);
      failures.push(`[${variant}] ${error.message}`);
    }
  }
  assertEqual(failures.length, 0, `relink variants failed: ${failures.join(' | ')}`);
}

async function aNoteThatIsNotUtf8NeverOpensBlank(_a, b) {
  // A note another editor saved in Latin-1 exists in the vault. Opening it must
  // not show a blank page (every save would then fail and the note could not
  // be left); the read failure takes the loader's designed path — back home,
  // nothing created. A rename of a note it links to leaves its bytes alone
  // (re-encoding them destroyed every byte that was not UTF-8).
  const latin = Buffer.from('caf\xe9 [[latin target]]', 'latin1');
  const name = 'latin note';
  await b._executeMutation(
    `window.__testNotes.createNote('latin target', 'target body')`,
    'createNote',
  );
  writeFileSync(join(b.notesDir, `${name}.md`), latin);
  await b._executeMutation(
    `window.location.hash = '#/note/${encodeURIComponent(name)}'`,
    'open latin note',
  );
  await sleep(1500);
  const state = await b.getOpenNoteState();
  console.log(`    [latin] after open: ${JSON.stringify(state)}`);
  assert(state.originalId !== name, `a note that cannot be read opened as a blank page`);
  assert(
    readFileSync(join(b.notesDir, `${name}.md`)).equals(latin),
    'opening the note changed its bytes',
  );

  await b.moveNote('latin target', 'latin target moved');
  const bytes = readFileSync(join(b.notesDir, `${name}.md`));
  assert(bytes.equals(latin), `a relink re-encoded the note: ${JSON.stringify([...bytes])}`);
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
    name: 'backlink rewrite propagation',
    fn: backlinkRewritePropagation,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'collision placement follows open note',
    fn: collisionPlacementFollowsOpenNote,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'collision name uses full object identity',
    fn: collisionNameUsesFullObjectIdentity,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'focused open note defers peer edit until blur',
    fn: focusedOpenNoteDefersPeerEditUntilBlur,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'a focused typist after a deferred peer edit mints exactly one copy',
    fn: focusedTypistAfterDeferredPeerEditMintsOneCopy,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'peer rename of the open note while a save is pending leaves no ghost',
    fn: peerRenameWhileSavePendingLeavesNoGhost,
    serverOptions: { syncDelayMs: 1500 },
    matrices: ['desktop-desktop'],
  },
  {
    name: 'a park inside a keyboard note switch leaves the switch alone',
    fn: parkInsideAKeyboardSwitchLeavesTheSwitchAlone,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'a folder or note rename relinking the open note does not park and keeps the typed word',
    fn: renameRelinkingTheOpenNoteDoesNotPark,
    matrices: ['desktop-desktop'],
  },
  {
    name: 'a note that is not UTF-8 never opens blank and a relink leaves its bytes alone',
    fn: aNoteThatIsNotUtf8NeverOpensBlank,
    matrices: ['desktop-desktop'],
  },
  // Folder-support v1 + pair_local_moved_objects rows — see FOLDER_MOVE_CASES.
  ...FOLDER_MOVE_CASES.map((row) => ({
    name: row.name,
    fn: (a, b, server) => runFolderMoveCase(row, a, b, server),
    matrices: ['desktop-desktop'],
  })),
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
  {
    name: 'overdeep local path is reported before upload',
    fn: overdeepLocalPathIsReportedBeforeUpload,
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
  {
    name: 'an external atomic save onto the open note is adopted',
    fn: externalAtomicSaveOntoTheOpenNoteIsAdopted,
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
  {
    name: 'self hosted bearer stays out of vault',
    fn: selfHostedBearerStaysOutOfVault,
    matrices: ['desktop-desktop'],
  },
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
  // Hosted sync (Log in with FUTO). Each needs a server in stand-in test mode,
  // which the pinned release does not carry yet — so on CI they skip with the
  // reason printed, and locally they run against a server built from the
  // `hosted-server` branch (FUTO_NOTES_E2EE_SERVER_REPO).
  {
    name: 'hosted no vault shape reaches a first sync',
    fn: hostedNoVaultShapeReachesAFirstSync,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  {
    name: 'hosted vault exists unlocks by vault password',
    fn: hostedVaultExistsUnlocksByVaultPassword,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  {
    name: 'hosted vault exists unlocks by recovery key',
    fn: hostedVaultExistsUnlocksByRecoveryKey,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  {
    name: 'hosted pairing between two desktop instances',
    fn: hostedPairingBetweenTwoDesktopInstances,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  {
    name: 'hosted lapsed subscription pauses writes and keeps reads',
    fn: hostedLapsedSubscriptionPausesWritesAndKeepsReads,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  {
    name: 'hosted full vault raises the vault full banner',
    fn: hostedFullVaultRaisesTheVaultFullBanner,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  {
    name: 'hosted sign out keeps the notes on disk',
    fn: hostedSignOutKeepsTheNotesOnDisk,
    matrices: ['desktop-desktop'],
    hosted: true,
  },
  {
    name: 'hosted restart syncs at launch without opening settings',
    fn: hostedRestartSyncsAtLaunchWithoutOpeningSettings,
    matrices: ['desktop-desktop'],
    hosted: true,
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
    name: 'android keeps an unreported edit over a peer edit',
    fn: androidKeepsAnUnreportedEditOverAPeerEdit,
    matrices: [ANDROID_MATRIX],
  },
  {
    name: 'android keeps an unreported edit over a peer delete',
    fn: androidKeepsAnUnreportedEditOverAPeerDelete,
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
    console.log(
      `dist/ has no chunk carrying ${REQUIRED_TEST_HOOKS.join(' + ')} — rebuilding desktop binary…`,
    );
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
  //
  // The stamp also records WHICH flags that build used, so a binary produced by
  // an older harness — one that did not bake VITE_HOSTED_SYNC, say — is rebuilt
  // rather than tested. Nothing in the bundle is greppable for a flag that
  // compiles away to `false`, so the stamp is the only honest record of it.
  const stamp = join(REPO_ROOT, 'target', 'debug', '.harness-binary-stamp');
  const expectedStamp = `${statSync(binPath).mtimeMs} ${HARNESS_BUILD_SIGNATURE}`;
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== expectedStamp) {
    console.log(
      'Desktop binary was not built by this harness with these flags (a `cargo tauri dev` build, or an older harness) — rebuilding…',
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

// What the harness bakes into its binary. `VITE_INCLUDE_TEST_HOOKS` is what
// makes `window.__testSync` exist at all; `VITE_HOSTED_SYNC` is what makes
// `hostedSyncEnabled()` true, and without it the built bundle compiles that
// function to `return false` — the hosted flow is off, and so is the launch
// resume that reads the saved vault at boot. The hosted scenarios used to pass
// on such a binary because `__testSync.connectHosted()` drives the Rust
// commands directly and never consults the flag; anything that runs on its own
// (like the restart-at-launch scenario) does not.
const HARNESS_BUILD_ENV = {
  VITE_INCLUDE_TEST_HOOKS: 'true',
  VITE_HOSTED_SYNC: 'true',
};

/** The stamp's second field: which flags the binary on disk was built with. */
const HARNESS_BUILD_SIGNATURE = Object.entries(HARNESS_BUILD_ENV)
  .map(([name, value]) => `${name}=${value}`)
  .join(' ');

function rebuildDesktopBinary() {
  // `just build-desktop-test` runs its own cargo-clean staleness guard (see
  // the justfile recipe) before building with these flags baked in, so every
  // rebuild — local or CI — gets it, and CI doesn't pay for a second
  // identical build.
  runOrThrow('just', ['build-desktop-test'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...HARNESS_BUILD_ENV },
  });
  const binPath = join(REPO_ROOT, 'target', 'debug', 'futo-notes-tauri');
  writeFileSync(
    join(REPO_ROOT, 'target', 'debug', '.harness-binary-stamp'),
    `${statSync(binPath).mtimeMs} ${HARNESS_BUILD_SIGNATURE}`,
  );
}

// Scan every emitted chunk, not `index-*.js`[0]: a build emits a dozen
// `index-<hash>.js` chunks and only ONE carries __testSync, so reading the
// alphabetically-first one almost always concluded "built without test hooks"
// and charged the run a `cargo clean -p` plus a full relink it did not need
// (papercut pc_b1be12680b61). vite empties dist/ per build, so nothing here can
// be a leftover from an older hooks-enabled bundle.
//
// Both names are required, and in the same chunk. `__testSync` alone was enough
// while the hook was one object; the hosted half arrived later
// (futo-notes#186), so a dist/ left over from before it — or from a branch
// without it — would pass a `__testSync`-only check and then fail six scenarios
// in with "connectHosted is not a function", which reads like a product bug
// rather than a stale build.
const REQUIRED_TEST_HOOKS = ['__testSync', 'connectHosted'];

function distHasTestHooks() {
  const assetsDir = join(REPO_ROOT, 'dist', 'assets');
  if (!existsSync(assetsDir)) return false;
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .some((name) => {
      const path = join(assetsDir, name);
      return REQUIRED_TEST_HOOKS.every((needle) => fileContains(path, needle));
    });
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

/** Run a list of scenarios against one client pair: fresh server per scenario,
 *  both clients reset in between, one result row each. */
async function runScenarios(list, clientA, clientB) {
  for (const scenario of list) {
    // main's slot-derived port band, not a bare counter: a hardcoded start had
    // every worktree allocating the same port, so a second run adopted the
    // first's server and database.
    const port = allocateServerPort();
    const serverSetupStartedAt = Date.now();
    const server = await startServer(port, {
      ...(scenario.hosted ? { mode: 'standin' } : {}),
      ...(scenario.serverOptions ?? {}),
    });
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

  // Build artifacts. Existing processes belong to their launching runs; the
  // launcher discovers a free bridge port and teardown stops only our children.
  const bootstrapStartedAt = Date.now();
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

  // Hosted scenarios need a server that HAS stand-in test mode. Until a release
  // carrying it is pinned, that means a local build — so on CI they skip, and
  // the banner says exactly what would change that rather than leaving a
  // shorter green run to look like a full one.
  const standin = standinModeAvailable();
  if (selected.some((scenario) => scenario.hosted) && !standin.available) {
    console.log('='.repeat(72));
    console.log('SKIP: the hosted (Log in with FUTO) scenarios need a stand-in server');
    console.log(`  reason: ${standin.why}`);
    console.log('  to include them: FUTO_NOTES_E2EE_SERVER_REPO=<futo-notes-server checkout>');
    console.log('                   FUTO_NOTES_E2EE_SERVER_STANDIN=1 just test-cross-platform');
    console.log('='.repeat(72));
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
    } else if (scenario.hosted && !standin.available) {
      // Never a silent pass (M11): the reason is in the row, in the banner
      // above, and in the JSON report.
      results.push({
        name: scenario.name,
        skip: true,
        reason: `no stand-in server: ${standin.why}`,
      });
      console.log(`  - ${scenario.name} (skipped: no stand-in server)`);
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
  const reportDir = process.env.FUTO_VERIFICATION_DIR || 'test-screenshots';
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

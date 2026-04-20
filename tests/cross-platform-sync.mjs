#!/usr/bin/env node
/**
 * Cross-platform sync integration tests.
 *
 * Boots two Tauri test clients and a sync server, then runs deterministic
 * multi-client sync scenarios through the full client stack:
 *   editor/UI → note session save pipeline → autoSync/syncManager →
 *   Rust core → HTTP → server → and back.
 *
 * Usage:
 *   node tests/cross-platform-sync.mjs
 *   node tests/cross-platform-sync.mjs --matrix desktop-android
 *   node tests/cross-platform-sync.mjs --scenario "five notes roundtrip"
 *
 * Requires:
 *   - Debug Tauri binary:  cd apps/tauri && cargo tauri build --debug --no-bundle
 *   - E2EE server repo:    /home/justin/Developer/stonefruit-server
 *   - Frontend built with: VITE_INCLUDE_TEST_HOOKS=true pnpm run build
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startDesktopTauriInstance } from './lib/tauri-instance.mjs';
import { startAndroidEmulatorInstance } from './lib/android-instance.mjs';
import { startServer } from './lib/sync-test-server.mjs';
import { sleep, executeJs } from './lib/mcp-client.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── CLI args ────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    scenario: { type: 'string' },
    matrix: { type: 'string', default: 'desktop-desktop' },
  },
});

// ── Test harness ────────────────────────────────────────────────

const results = [];
let serverPortCounter = 4000;

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function waitForOpenNoteTitle(client, expectedTitle, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await client.getOpenNoteState();
    if (state.title === expectedTitle) return state;
    await sleep(100);
  }
  throw new Error(`${client.name}: title did not become ${JSON.stringify(expectedTitle)} after ${timeoutMs}ms`);
}

async function waitForEditorContent(client, expectedContent, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await client.getOpenNoteState();
    if (state.editorContent === expectedContent) return state;
    await sleep(100);
  }
  throw new Error(`${client.name}: editor content did not become ${JSON.stringify(expectedContent)} after ${timeoutMs}ms`);
}

async function waitForSavePending(client, expected, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await client.getOpenNoteState();
    if (state.savePending === expected) return state;
    await sleep(50);
  }
  throw new Error(`${client.name}: savePending did not become ${expected} after ${timeoutMs}ms`);
}

async function createNoteViaEditor(client, title, content) {
  await client.openNewNote();
  await client.setTitle(title);
  await client.typeInEditor(content);
}

async function waitForToastMessage(client, expectedMessage, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await client.getOpenNoteState();
    if (state.toastMessage === expectedMessage) return state;
    await sleep(100);
  }
  throw new Error(`${client.name}: toast did not become ${JSON.stringify(expectedMessage)} after ${timeoutMs}ms`);
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
    const items = await executeJs(client.ws,
      `[...document.querySelectorAll('.note-item')].map(el => el.textContent.trim())`);
    if (items.some(t => t.includes(titleSubstring))) return;
  }
  throw new Error(`"${titleSubstring}" not found in ${client.name}'s sidebar after ${timeoutMs}ms`);
}

/** Get all note titles currently visible in the sidebar. */
async function getSidebarTitles(client) {
  return executeJs(client.ws,
    `[...document.querySelectorAll('.note-item')].map(el => el.textContent.trim())`);
}

// ── Scenarios ───────────────────────────────────────────────────

async function editorRoundtripThroughRealSync(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  const noteId = 'editor roundtrip';
  const body = '# Written in CodeMirror\nThis note should sync through the real save pipeline.';

  // A creates a new note through the actual editor path and syncs before the debounce fires.
  await createNoteViaEditor(a, noteId, body);
  const pendingState = await waitForSavePending(a, true);
  assertEqual(pendingState.originalId, null, 'new note should still be unsaved before manual sync flush');
  const aResult = await a.syncNow();
  assert(aResult.summary.uploaded === 1, `A uploaded=${aResult.summary.uploaded}, expected 1`);

  const postSyncState = await waitForSavePending(a, false);
  assertEqual(postSyncState.originalId, noteId, 'manual sync should flush the pending editor save before syncing');

  // B syncs — gets the note (auto-sync may have already fetched it, so
  // downloaded can be 0 or 1 depending on timing).  The important thing
  // is that B has the correct file on disk afterwards.
  const bResult = await b.syncNow();
  assert(bResult.summary.downloaded <= 1, `B downloaded=${bResult.summary.downloaded}, expected 0 or 1`);

  const diskContent = await b.readNote(noteId);
  assertEqual(diskContent, body, `${noteId} content mismatch`);

  await waitForNoteInSidebar(a, noteId);
  await waitForNoteInSidebar(b, noteId);
  await b.openNote(noteId);
  await waitForOpenNoteTitle(b, noteId);
  await waitForEditorContent(b, body);
  const bSidebar = await getSidebarTitles(b);
  const syncedCount = bSidebar.filter(t => t.includes(noteId)).length;
  assertEqual(syncedCount, 1, `B sidebar should show exactly one synced editor note`);
}

async function concurrentEditConflict(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

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
  assert(bResult.summary.conflicts > 0, `B should have conflicts, got ${bResult.summary.conflicts}`);

  // B should have A's version as the canonical copy
  const bCanonical = await b.readNote('shared note');
  assertEqual(bCanonical, "# A's version", 'B canonical should be A\'s version');

  // A picks up conflict copy so both have identical file sets
  await a.syncNow();
  const aFiles = await a.listNotes();
  const bFiles = await b.listNotes();
  const aNames = new Set(aFiles.map(f => f.filename || f.name || f));
  const bNames = new Set(bFiles.map(f => f.filename || f.name || f));
  assertEqual(aNames.size, bNames.size, 'A and B should have same number of files');

  // Verify both clients' sidebars show the shared note + conflict copy
  await waitForNoteInSidebar(b, 'shared note');
  const bSidebar = await getSidebarTitles(b);
  assert(bSidebar.length >= 2, `B sidebar should show at least 2 notes (original + conflict), got ${bSidebar.length}`);
  assert(bSidebar.some(t => t.includes('conflict')),
    `B sidebar should show a conflict copy, got: ${JSON.stringify(bSidebar)}`);
}

async function threeWayMerge(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

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
  const conflictFiles = aFiles.filter(f => {
    const name = f.filename || f.name || f;
    return name.includes('conflict');
  });
  assertEqual(conflictFiles.length, 0, 'clean merge should produce no conflict copies');
}

async function renamePropagation(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

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
  assertEqual(state.hash, `#/note/${encodeURIComponent('new name')}`, 'route should follow the renamed note');
  await sleep(1200);
  const stableState = await b.getOpenNoteState();
  assertEqual(stableState.originalId, 'new name', 'open note should remain stable after watcher aftermath');
  assertEqual(stableState.hash, `#/note/${encodeURIComponent('new name')}`, 'route should remain stable after watcher aftermath');
  assertEqual(stableState.toastMessage, '', 'remote rename should not surface a delete/change toast');
}

async function activeNoteReload(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  await a.writeNote('shared live', '# Version 1');
  await a.syncNow();
  await b.syncNow();

  await b.openNote('shared live');
  await waitForEditorContent(b, '# Version 1');

  await a.writeNote('shared live', '# Version 2\nRemote update');
  await a.syncNow();

  const bResult = await b.syncNow();
  assert(bResult.summary.downloaded <= 1, `B downloaded=${bResult.summary.downloaded}, expected 0 or 1`);
  const state = await waitForEditorContent(b, '# Version 2\nRemote update');
  assertEqual(state.originalId, 'shared live', 'open note should remain the same note after remote update');
  // The remote content reload triggers a change event in the editor which starts
  // the save debounce.  Wait for it to settle before asserting no pending save.
  const settled = await waitForSavePending(b, false);
  assertEqual(settled.savePending, false, 'remote reload should not leave a local save pending');
}

async function editDuringSyncKeepsLocalDraft(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  await a.writeNote('taken sync title', '# Blocking title');
  await a.writeNote('during sync', '# Base');
  await a.syncNow();
  await b.syncNow();

  await b.openNote('during sync');
  await waitForEditorContent(b, '# Base');
  await b.setTitle('taken sync title');
  await waitForSavePending(b, false);

  await a.writeNote('during sync', '# Remote update');
  await a.syncNow();

  await b.startSync();
  await sleep(200);
  await b.typeInEditor('\nLocal draft typed during sync');
  await waitForSavePending(b, true);
  await waitForSavePending(b, false);
  const draftDuringSync = (await b.getOpenNoteState()).editorContent;

  const bResult = await b.awaitStartedSync();
  assert(bResult.summary.downloaded === 1, `B downloaded=${bResult.summary.downloaded}, expected 1`);

  const preservedState = await waitForEditorContent(b, draftDuringSync);
  assertEqual(preservedState.originalId, 'during sync', 'open note should remain on the local draft during sync');
  assertEqual(preservedState.hash, `#/note/${encodeURIComponent('during sync')}`, 'route should stay on the edited note during sync');

  await b.setTitle('during sync');
  await b.flushSave();
  await waitForSavePending(b, false);
  await b.syncNow();
  await a.syncNow();
  const aContent = await a.readNote('during sync');
  assertEqual(aContent, draftDuringSync, 'local draft should still be persistable after being protected from sync clobbering');
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
  assertEqual(state.originalId, 'watch clean', 'clean external change should keep the same note open');
  assertEqual(state.hash, `#/note/${encodeURIComponent('watch clean')}`, 'clean external change should keep the same route');
  assertEqual(state.toastMessage, '', 'clean external change should not show a draft-preservation toast');
}

async function externalWatcherKeepsDirtyDraft(a, _b, _server) {
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
  await waitForSavePending(a, false);
  const localDraft = (await a.getOpenNoteState()).editorContent;
  await sleep(1200);

  await externalWriteNote(a, 'watch dirty', '# Changed on disk');

  const protectedState = await waitForToastMessage(a, 'Open note changed externally; keeping local draft', 30_000);
  assertEqual(protectedState.originalId, 'watch dirty', 'dirty external change should keep the original note open');
  assertEqual(protectedState.hash, `#/note/${encodeURIComponent('watch dirty')}`, 'dirty external change should keep the same route');
  assertEqual(protectedState.title, 'taken title', 'dirty external change should keep the unsaved title draft');
  assertEqual(protectedState.editorContent, localDraft, 'dirty external change should keep the unsaved editor draft');
  const diskContent = await a.readNote('watch dirty');
  assertEqual(diskContent, '# Changed on disk', 'external disk content should still land on disk while the UI keeps the draft');
}

async function deleteVsEdit(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  // Both get a shared note
  await a.writeNote('contested', '# Original');
  await a.syncNow();
  await b.syncNow();

  // A deletes, B edits
  await a.deleteNote('contested');
  await b.writeNote('contested', '# B edited this');

  // B syncs first — edit wins
  await b.syncNow();

  // A syncs — gets the edit back (server preserves the edit).
  // Auto-sync may have already sent the delete, so A might need a
  // second sync to pick up B's version after the server resolves it.
  await a.syncNow();
  let aContent;
  try {
    aContent = await a.readNote('contested');
  } catch {
    // File may not exist yet if the first sync sent the delete —
    // a second sync should retrieve B's edit from the server.
    await a.syncNow();
    aContent = await a.readNote('contested');
  }
  assertEqual(aContent, '# B edited this', 'A should get B\'s edit back');
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
  assert(result.summary.conflicts === 0,
    `Recovery should not create conflicts, got ${result.summary.conflicts}`);

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
    assert(status.appState.serverUrl || status.preferences?.sync?.serverUrl,
      `Iteration ${i}: should have server URL after connect`);
    await a.disconnectSync();
  }

  // Final connect — verify clean state
  await a.connectSync(server.url, server.password);
  const finalStatus = await a.syncStatus();
  assert(finalStatus.appState.fileHashes === undefined
    || Object.keys(finalStatus.appState.fileHashes || {}).length === 0,
    'fileHashes should be empty after fresh connect');
}

async function offlineAccumulation(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);

  // A writes 10 unique notes without syncing
  for (let i = 0; i < 10; i++) {
    await a.writeNote(`a only ${i}`, `# A Note ${i}`);
  }

  // B writes 10 different unique notes without syncing
  for (let i = 0; i < 10; i++) {
    await b.writeNote(`b only ${i}`, `# B Note ${i}`);
  }

  // A syncs (uploads 10 — auto-sync may have sent some already)
  const aResult = await a.syncNow();
  assert(aResult.summary.uploaded <= 10, `A uploaded=${aResult.summary.uploaded}, expected ≤10`);

  // B syncs (uploads its 10, downloads A's 10 — auto-sync may have handled some)
  const bResult = await b.syncNow();
  assert(bResult.summary.uploaded <= 10, `B uploaded=${bResult.summary.uploaded}, expected ≤10`);
  assert(bResult.summary.downloaded <= 10, `B downloaded=${bResult.summary.downloaded}, expected ≤10`);

  // A syncs again to pick up B's notes
  const aResult2 = await a.syncNow();
  assert(aResult2.summary.downloaded <= 10, `A second sync downloaded=${aResult2.summary.downloaded}, expected ≤10`);

  // Both should have all 20 notes
  for (let i = 0; i < 10; i++) {
    assert(await a.noteExists(`b only ${i}`), `A should have b only ${i}`);
    assert(await b.noteExists(`a only ${i}`), `B should have a only ${i}`);
  }
}

/** Generate realistic note content with varying length (500–2000 bytes). */
function generateNoteContent(i) {
  const topics = ['meeting notes', 'project plan', 'research', 'journal', 'recipe', 'book notes', 'travel log', 'todo list'];
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
  assert(aResult.summary.uploaded <= COUNT, `A uploaded=${aResult.summary.uploaded}, expected ≤${COUNT}`);

  // B syncs — may need multiple passes because auto-sync and manual sync can
  // race on who fetches first, and the server may batch-deliver across passes.
  const bFiles = new Set();
  for (let attempt = 0; attempt < 5; attempt++) {
    await b.syncNow();
    const listed = await b.listNotes();
    for (const f of listed) {
      const name = f.filename || f.name || f;
      if (typeof name === 'string' && name.startsWith('bulk ')) bFiles.add(name.replace(/\.md$/, ''));
    }
    if (bFiles.size >= COUNT) break;
    await sleep(500);
  }
  assert(bFiles.size === COUNT, `B ended with ${bFiles.size} bulk notes on disk, expected ${COUNT}`);

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

  // Delete it and sync — server creates a tombstone
  await a.deleteNote('Untitled');
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
  await waitForSavePending(a, false);
  const syncResult = await a.syncNow();

  // The sync must NOT delete the note we just created
  assert(
    !syncResult.summary.deletedIds?.includes('Untitled'),
    'sync should not return Untitled in deletedIds',
  );

  // No spurious toast should appear
  await sleep(500);
  const finalState = await a.getOpenNoteState();
  assertEqual(finalState.toastMessage, '', 'no toast should appear after syncing re-created note');
  assert(await a.noteExists('Untitled'), 'Untitled should still exist on disk');
}

// ── Scenario registry ───────────────────────────────────────────

const scenarios = [
  { name: 'editor roundtrip through real sync', fn: editorRoundtripThroughRealSync, matrices: ['desktop-desktop', 'desktop-android'] },
  { name: 'edit during sync keeps local draft', fn: editDuringSyncKeepsLocalDraft, serverOptions: { syncDelayMs: 1500 }, matrices: ['desktop-desktop', 'desktop-android'] },
  { name: 'concurrent edit conflict', fn: concurrentEditConflict, matrices: ['desktop-desktop'] },
  { name: 'three way merge', fn: threeWayMerge, matrices: ['desktop-desktop'] },
  { name: 'rename propagation', fn: renamePropagation, matrices: ['desktop-desktop', 'desktop-android'] },
  { name: 'active note reload', fn: activeNoteReload, matrices: ['desktop-desktop', 'desktop-android'] },
  // TODO(justin): both external-watcher scenarios race under Docker/xvfb.
  // They swap which one hits the inotify delay run-to-run; one or the other
  // times out at 30s roughly half the time. Locally they pass in <2s, so
  // keep them enabled off-CI. Investigate separately — the notify crate's
  // event loop may be starved while the single-threaded xvfb renders, or
  // the CodeMirror update path may be blocked by unrelated IPC traffic.
  { name: 'external watcher reloads clean note', fn: externalWatcherReloadsCleanNote, matrices: ['desktop-desktop'], skipOnCi: true },
  { name: 'external watcher keeps dirty draft', fn: externalWatcherKeepsDirtyDraft, matrices: ['desktop-desktop'], skipOnCi: true },
  { name: 'delete vs edit', fn: deleteVsEdit, matrices: ['desktop-desktop', 'desktop-android'] },
  { name: 'lost state recovery', fn: lostStateRecovery, matrices: ['desktop-desktop', 'desktop-android'] },
  { name: 'rapid reconnect', fn: rapidReconnect, matrices: ['desktop-desktop', 'desktop-android'] },
  { name: 'offline accumulation', fn: offlineAccumulation, matrices: ['desktop-desktop', 'desktop-android'] },
  { name: 'large sync', fn: largeSync, matrices: ['desktop-desktop', 'desktop-android'] },
  { name: 'tombstone does not block new note', fn: tombstoneDoesNotBlockNewNote, matrices: ['desktop-desktop'] },
];

// ── Main ────────────────────────────────────────────────────────

const managedStops = [];

const matrixLaunchers = {
  'desktop-desktop': {
    label: 'desktop ↔ desktop',
    startClients: async () => ([
      await startDesktopTauriInstance('client-a', REPO_ROOT),
      await startDesktopTauriInstance('client-b', REPO_ROOT),
    ]),
  },
  'desktop-android': {
    label: 'desktop ↔ android-emulator',
    startClients: async () => ([
      await startDesktopTauriInstance('client-a', REPO_ROOT),
      await startAndroidEmulatorInstance('client-b', REPO_ROOT),
    ]),
  },
};

function cleanup() {
  for (const stop of [...managedStops].reverse()) {
    try { stop(); } catch { /* ignore */ }
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
  const distJs = findDistIndexJs();
  if (!distJs || !fileContains(distJs, '__testSync')) {
    console.log('dist/ was built without VITE_INCLUDE_TEST_HOOKS — rebuilding desktop binary…');
    rebuildDesktopBinary();
  }
}

function rebuildDesktopBinary() {
  runOrThrow('cargo', ['tauri', 'build', '--debug', '--no-bundle'], {
    cwd: join(REPO_ROOT, 'apps', 'tauri'),
    env: { ...process.env, VITE_INCLUDE_TEST_HOOKS: 'true' },
  });
}

function ensureAndroidApk() {
  const apkPath = join(REPO_ROOT, 'apps', 'tauri', 'src-tauri', 'gen', 'android', 'app',
    'build', 'outputs', 'apk', 'universal', 'debug', 'app-universal-debug.apk');
  if (!existsSync(apkPath)) {
    console.log('Android APK missing — building with test hooks…');
    rebuildAndroidApk();
    return;
  }
  const distJs = findDistIndexJs();
  if (!distJs || !fileContains(distJs, '__testSync')) {
    console.log('dist/ missing test hooks — rebuilding Android APK…');
    rebuildAndroidApk();
  }
}

function rebuildAndroidApk() {
  // Ensure x86_64 ORT for emulator + arm64 for devices.
  runOrThrow('node', ['scripts/fetch-ort-android.mjs', '--abis', 'arm64-v8a,x86_64'], {
    cwd: REPO_ROOT,
  });
  runOrThrow('cargo', [
    'tauri', 'android', 'build', '--debug', '--apk',
    '--config', 'src-tauri/tauri.android.dev-mode.conf.json',
  ], {
    cwd: join(REPO_ROOT, 'apps', 'tauri'),
    env: { ...process.env, VITE_INCLUDE_TEST_HOOKS: 'true' },
  });
}

function findDistIndexJs() {
  const assetsDir = join(REPO_ROOT, 'dist', 'assets');
  if (!existsSync(assetsDir)) return null;
  const files = readdirSync(assetsDir).filter((n) => /^index-.*\.js$/.test(n));
  if (files.length === 0) return null;
  return join(assetsDir, files[0]);
}

function fileContains(path, needle) {
  try {
    return readFileSync(path, 'utf8').includes(needle);
  } catch { return false; }
}

function runOrThrow(cmd, argv, opts) {
  const res = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${argv.join(' ')} failed with exit ${res.status}`);
  }
}

function killStalePreviewAndClients() {
  // A vite preview left behind by an interrupted previous run will keep port
  // 5181 busy; a leftover debug binary will hold an MCP port. Clear them so
  // the harness boots cleanly every time.
  const lsofOut = spawnSync('lsof', ['-ti', 'tcp:5181'], { encoding: 'utf8' });
  const pids = (lsofOut.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ }
  }
  // Only kill debug binaries spawned with the multi-instance flag — that's
  // how the harness launches them, so this won't touch a user's open app.
  const ps = spawnSync('pgrep', ['-af', 'futo-notes-tauri'], { encoding: 'utf8' });
  const lines = (ps.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const [_, pidStr, cmdline] = match;
    // Only kill binaries from this repo's target/debug — a conservative check
    // that excludes the user's installed Stonefruit.
    if (cmdline.includes(`${REPO_ROOT}/target/debug/futo-notes-tauri`)) {
      try { process.kill(Number(pidStr), 'SIGTERM'); } catch { /* ignore */ }
    }
  }
}

async function main() {
  console.log('Cross-platform sync integration tests\n');

  const matrix = matrixLaunchers[args.matrix];
  if (!matrix) {
    throw new Error(`Unknown matrix "${args.matrix}". Expected one of: ${Object.keys(matrixLaunchers).join(', ')}`);
  }
  console.log(`Matrix: ${matrix.label}\n`);

  // Bootstrap artifacts and clean up stale state from a prior run.
  killStalePreviewAndClients();
  ensureDesktopDebugBinary();
  if (args.matrix === 'desktop-android') {
    ensureAndroidApk();
  }

  // Filter scenarios if --scenario is set
  const selected = args.scenario
    ? scenarios.filter(s => s.name.toLowerCase().includes(args.scenario.toLowerCase()))
    : scenarios;

  if (selected.length === 0) {
    console.error(`No scenarios matching "${args.scenario}"`);
    process.exit(1);
  }

  const toRun = [];
  for (const scenario of selected) {
    if (!scenario.matrices.includes(args.matrix)) {
      results.push({ name: scenario.name, skip: true, reason: `not included in matrix ${args.matrix}` });
      console.log(`  - ${scenario.name} (skipped: not included in matrix ${args.matrix})`);
    } else if (scenario.skipOnCi && process.env.CI) {
      results.push({ name: scenario.name, skip: true, reason: 'skipOnCi' });
      console.log(`  - ${scenario.name} (skipped: flaky on CI — see scenario registry TODO)`);
    } else {
      toRun.push(scenario);
    }
  }

  if (toRun.length === 0) {
    throw new Error(`No runnable scenarios for matrix ${args.matrix}`);
  }

  // ── Suite setup: start 2 Tauri instances (done once) ──────────
  console.log('\nStarting Tauri instances...');

  const [clientA, clientB] = await matrix.startClients();
  managedStops.push(() => clientB.stop());
  managedStops.push(() => clientA.stop());
  console.log(`  Client A ready (${clientA.platform}, MCP port ${clientA.port ?? 'n/a'})`);
  console.log(`  Client B ready (${clientB.platform}, MCP port ${clientB.port ?? 'n/a'})`);

  console.log('');

  // ── Run scenarios ─────────────────────────────────────────────
  for (const scenario of toRun) {
    const port = serverPortCounter++;
    const server = await startServer(port, REPO_ROOT, scenario.serverOptions ?? {});
    managedStops.push(() => server.stop());

    const start = Date.now();
    try {
      // Reset clients between scenarios
      await clientA.reset();
      await clientB.reset();

      await scenario.fn(clientA, clientB, server);

      const ms = Date.now() - start;
      results.push({ name: scenario.name, pass: true, ms });
      console.log(`  ✓ ${scenario.name} (${ms}ms)`);
    } catch (err) {
      const ms = Date.now() - start;
      results.push({ name: scenario.name, pass: false, ms, error: err.message });
      console.log(`  ✗ ${scenario.name} (${ms}ms)`);
      console.log(`    ${err.message}`);
    } finally {
      server.stop();
    }
  }

  // ── Report ────────────────────────────────────────────────────
  console.log('');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => r.pass === false).length;
  const skipped = results.filter(r => r.skip).length;
  const totalRun = passed + failed;
  console.log(`Results: ${passed}/${totalRun} passed, ${failed} failed, ${skipped} skipped`);

  // Write JSON report
  const reportDir = 'test-screenshots';
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(reportDir, 'sync-results.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), matrix: args.matrix, results }, null, 2),
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

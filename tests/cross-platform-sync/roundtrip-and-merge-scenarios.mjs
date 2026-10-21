/**
 * Scenarios: editor round trip through real sync, conflicts, three-way merge,
 * backlink rewrite and rename propagation.
 */

import { sleep } from '../lib/mcp-client.mjs';
import {
  assert,
  assertEqual,
  getSidebarTitles,
  waitForEditorContent,
  waitForNoteInSidebar,
  waitForOpenNoteTitle,
  waitForSaveIdle,
} from './waits-and-assertions.mjs';

// ── Scenarios ───────────────────────────────────────────────────

export async function editorRoundtripThroughRealSync(a, b, server) {
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
  // docs/spec/editor.md "WYSIWYG rendering"), so the bytes asserted back are
  // not the bytes typed.
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

export async function concurrentEditConflict(a, b, server) {
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

export async function threeWayMerge(a, b, server) {
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

export async function backlinkRewritePropagation(a, b, server) {
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

export async function renamePropagation(a, b, server) {
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

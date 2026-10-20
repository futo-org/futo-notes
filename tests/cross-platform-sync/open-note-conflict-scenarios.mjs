/**
 * Scenarios: collisions and peer edits landing on the open note (placement,
 * deferral until blur, edits during a sync).
 */

import { sleep } from '../lib/mcp-client.mjs';
import {
  assert,
  assertEqual,
  waitForEditorContent,
  waitForNoteInSidebar,
  waitForOpenNoteTitle,
  waitForSaveIdle,
} from './waits-and-assertions.mjs';

export async function collisionPlacementFollowsOpenNote(a, b, server) {
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

export async function collisionNameUsesFullObjectIdentity(a, b, server) {
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

export async function focusedOpenNoteDefersPeerEditUntilBlur(a, b, server) {
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

export async function editDuringSyncKeepsLocalDraft(a, b, server) {
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

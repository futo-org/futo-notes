/**
 * Scenarios: a dirty draft meeting a peer edit, and external (watcher) writes
 * onto the open note.
 */

import { sleep } from '../lib/mcp-client.mjs';
import {
  assert,
  assertEqual,
  externalWriteNote,
  waitForEditorContent,
  waitForNoteInSidebar,
  waitForSaveIdle,
  waitForToastClear,
} from './waits-and-assertions.mjs';

export async function dirtyDraftSurvivesAPeerEditThenSettles(a, b, server) {
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

export async function externalWatcherReloadsCleanNote(a, _b, _server) {
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

export async function externalAtomicSaveOntoTheOpenNoteIsAdopted(a, _b, _server) {
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

export async function externalWatcherProtectsDirtyDraftThenSettles(a, _b, _server) {
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

/**
 * Scenarios: delete versus edit, lost-state recovery, reconnects, offline
 * accumulation, large syncs and tombstones.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from '../lib/mcp-client.mjs';
import {
  assert,
  assertEqual,
  waitForEditorContent,
  waitForOpenNoteState,
  waitForSaveIdle,
} from './waits-and-assertions.mjs';

export async function deleteVsEdit(a, b, server) {
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
export async function peerDeleteOfOpenNoteClosesEditor(a, b, server) {
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

export async function lostStateRecovery(a, _b, server) {
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

export async function selfHostedBearerStaysOutOfVault(a, _b, server) {
  await a.connectSync(server.url, server.password);
  const statePath = join(a.notesDir, '.app-state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert(!Object.hasOwn(state, 'e2eeAuthToken'), 'vault app state must not carry the bearer token');
  await a.syncNow();
  await a.disconnectSync();
}

export async function rapidReconnect(a, _b, server) {
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

export async function offlineAccumulation(a, b, server) {
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

export async function largeSync(a, b, server) {
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

export async function tombstoneDoesNotBlockNewNote(a, b, server) {
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

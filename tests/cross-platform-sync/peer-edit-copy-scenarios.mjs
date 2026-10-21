/**
 * Scenarios: conflict copies after a deferred peer edit, and peer renames while a save is pending.
 */

import { sleep } from '../lib/mcp-client.mjs';
import {
  assert,
  assertEqual,
  waitForEditorContent,
  waitForSaveIdle,
} from './waits-and-assertions.mjs';

export async function conflictCopiesOf(client, title) {
  const files = (await client.listNotes()).map((file) =>
    String(file.filename || file.name || file),
  );
  return files.filter((name) => name.startsWith(`${title} (conflict`));
}

export async function focusedTypistAfterDeferredPeerEditMintsOneCopy(a, b, server) {
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

export async function peerRenameWhileSavePendingLeavesNoGhost(a, b, server) {
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

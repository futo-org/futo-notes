/**
 * Scenario: an in-app title rename keeps its sync identity while a peer edits
 * the old name (issue #214). Pre-fix, both clients ended with the peer's edit
 * resurrected at the old name and only the original body at the new one.
 */

import {
  assert,
  assertEqual,
  waitForEditorContent,
  waitForOpenNoteState,
  waitForSaveIdle,
} from './waits-and-assertions.mjs';

export async function offlineTitleRenameKeepsIdentityUnderAPeerEdit(a, b, server) {
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  // Each explicit syncNow owns its cycle: B's rename must reach the server
  // only after A's edit of the old name did.
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  const before = 'identity before rename';
  const after = 'identity after rename';
  await a.writeNote(before, 'Origin');
  await a.syncNow();
  await b.syncNow();
  assert(await b.noteExists(before), 'B should receive the note');

  // B renames through the editor title: the store's journaled rename.
  await b.openNote(before);
  await waitForEditorContent(b, 'Origin');
  await b.focusEditor();
  await b.setTitle(after);
  await b.flushSave();
  await waitForOpenNoteState(b, 'follow the title rename', (state) => state.originalId === after);
  await waitForSaveIdle(b);

  // A edits the old name and syncs before B's rename does.
  await a.writeNote(before, 'Local typing Origin');
  await a.syncNow();

  const bResult = await b.syncNow();
  const aResult = await a.syncNow();
  for (const [label, client] of [
    ['A', a],
    ['B', b],
  ]) {
    assert(!(await client.noteExists(before)), `${label} must not keep or resurrect the old name`);
    assertEqual(
      await client.readNote(after),
      'Local typing Origin',
      `${label}: the renamed note carries the peer edit`,
    );
  }
  for (const [label, result] of [
    ['A', aResult],
    ['B', bResult],
  ]) {
    const renames = result.summary.renamed ?? [];
    assert(
      renames.some((pair) => pair.fromId === before && pair.toId === after),
      `${label} should report the rename, got ${JSON.stringify(renames)}`,
    );
  }
}

/**
 * Scenarios: folder moves, folder/file name clashes, unportable and over-deep paths.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FOLDER_MOVE_STEPS } from './folder-move-cases.mjs';
import { assert, assertEqual } from './waits-and-assertions.mjs';

async function listNoteIds(client) {
  return (await client.listNotes())
    .map((f) => (f.name || f.filename || f).replace(/\.md$/, ''))
    .sort();
}

export async function runFolderMoveCase(row, a, b, server) {
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

export async function folderXVsFileXAtSameLevel(a, b, server) {
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

export async function moveIntoFolderWithExistingFilename(a, _b, _server) {
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

export async function emptyFolderDoesNotSync(a, b, server) {
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

export async function unportableNameNeverSyncsAndIsLeftAlone(a, b, server) {
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

export async function overdeepLocalPathIsReportedBeforeUpload(a, b, server) {
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

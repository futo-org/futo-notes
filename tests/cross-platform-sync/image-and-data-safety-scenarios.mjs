/**
 * Scenarios: image sync round trip and the sync data-safety fixes (F1 / F3 / F9).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, assertEqual } from './waits-and-assertions.mjs';

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
export async function imageSyncRoundtrip(a, b, server) {
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

export async function peerDeletesWhileDisconnected(a, b, server) {
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

export async function editVsPeerDeletePreservesEdit(a, b, server) {
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

export async function distinctSameBasenameSurvivesMoveDedup(a, b, server) {
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

/**
 * The folder-move conflict table and the step verbs its rows are written in.
 */

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
export const FOLDER_MOVE_CASES = [
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

export const FOLDER_MOVE_STEPS = {
  write: (client, id, body) => client.writeNote(id, body),
  delete: (client, id) => client.deleteNote(id),
  move: (client, from, to) => client.moveNote(from, to),
  mkdir: (client, path) => client.createFolder(path),
  rmdir: (client, path) => client.deleteFolder(path),
};

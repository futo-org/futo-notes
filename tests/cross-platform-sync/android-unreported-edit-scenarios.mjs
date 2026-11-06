/**
 * Android-leg scenarios: edits the editor has not reported yet, peer rename, and conflicts.
 */

import { HARNESS_NOTE_PREFIX } from '../lib/android-native-instance.mjs';
import { sleep } from '../lib/mcp-client.mjs';
import {
  ANDROID_SHARED_NOTE,
  waitForAndroidConflictCopy,
  waitForDesktopNoteContent,
} from './android-leg-scenarios.mjs';
import { assert, assertEqual } from './waits-and-assertions.mjs';

// RC-08 (FB-5): the open-note verdict must see an edit the editor has not
// reported yet. A large note withholds `change` while its tail streams, so the
// shell's copy — which the verdict used to be taken on — still equals the base
// after the user typed and dismissed the keyboard. A peer edit then classified
// as a clean Adopt and `applyExternalContent` discarded the edit; a peer delete
// classified as Close. The shell now reads the editor before it classifies.
//
// Outcome-based on purpose: whether the engine answers KeepDraft (the read
// answered) or nothing at all (the read ran out of its deadline while the
// renderer finished the tail — then the released `change` reaches the ordinary
// save, whose flush verb parks it), the typed text must survive and so must
// the peer's.
const UNREPORTED_EDIT_SECTIONS = 20_000;

function streamingSizedNote(title) {
  const sections = Array.from(
    { length: UNREPORTED_EDIT_SECTIONS },
    (_, i) => `## Section ${i}\n\nBody line ${i} of a note long enough to stream.`,
  );
  return `# ${title}\n\n${sections.join('\n\n')}\n`;
}

/** Open `id`, type `marker` while its tail is still streaming, and prove the
 *  focused edit is still unreported when this returns. Blur now flushes it. */
async function typeUnreportedEditWhileStreaming(android, id, base, marker) {
  await android.openNoteInEditor(id);
  await android.focusOpenEditor();
  await android.typeIntoOpenEditor(marker);
  // M11: the window this scenario exists for. A stream that already finished
  // released the `change`, and the verdict below would pass for the wrong
  // reason — raise UNREPORTED_EDIT_SECTIONS rather than accept that.
  assert(
    await android.isOpenEditorStreaming(),
    'the note finished streaming before the peer change could land — the edit is ' +
      'already reported, so this run proves nothing',
  );
  assertEqual(android.readNote(id), base, 'the typed edit must not have been saved yet');
}

/** Every harness note in the Android vault holding `text`, by id. */
function androidNotesContaining(android, text) {
  return android
    .listNoteFilenames()
    .filter((name) => name.startsWith(HARNESS_NOTE_PREFIX))
    .map((name) => name.replace(/\.md$/, ''))
    .filter((candidate) => (android.readNote(candidate) ?? '').includes(text));
}

async function waitForAndroidNoteContaining(android, text, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hits = androidNotesContaining(android, text);
    if (hits.length > 0) return hits;
    await sleep(1_000);
  }
  throw new Error(
    `${android.name}: no note holds ${JSON.stringify(text)} — the unreported edit was discarded ` +
      `(notes: ${JSON.stringify(android.listNoteFilenames())})`,
  );
}

export async function androidKeepsAnUnreportedEditOverAPeerEdit(desktop, android, server) {
  await desktop.connectSync(server.url, server.password);
  await android.connectSync(server.url, server.password);
  await desktop.pauseAutoSync();

  const id = `${HARNESS_NOTE_PREFIX}unreported-edit`;
  const base = streamingSizedNote('unreported edit');
  await desktop.writeNote(id, base);
  await desktop.syncNow();
  await android.waitForNoteContent(id, base);

  // No trailing space: the caret lands at the end of the first streamed chunk,
  // which is a heading, and the editor does not write whitespace at the end of
  // a line (docs/spec/editor.md, Markdown serialization), so a typed space
  // there never reaches the file.
  const marker = 'TYPEDWHILESTREAMING';
  await typeUnreportedEditWhileStreaming(android, id, base, marker);

  const peerEdit = base.replace('Body line 1 of', 'Body line 1 (peer edit) of');
  await desktop.writeNote(id, peerEdit);
  await desktop.syncNow();

  await waitForAndroidNoteContaining(android, marker);
  await waitForAndroidNoteContaining(android, '(peer edit)');
}

export async function androidKeepsAnUnreportedEditOverAPeerDelete(desktop, android, server) {
  await desktop.connectSync(server.url, server.password);
  await android.connectSync(server.url, server.password);
  await desktop.pauseAutoSync();

  const id = `${HARNESS_NOTE_PREFIX}unreported-delete`;
  const base = streamingSizedNote('unreported delete');
  await desktop.writeNote(id, base);
  await desktop.syncNow();
  await android.waitForNoteContent(id, base);

  // No trailing space, for the reason in androidKeepsAnUnreportedEditOverAPeerEdit.
  const marker = 'TYPEDBEFOREPEERDELETE';
  await typeUnreportedEditWhileStreaming(android, id, base, marker);

  await desktop.deleteNoteInApp(id);
  await desktop.syncNow();

  // Persist-or-park: the draft stays open and its save recreates the note.
  await waitForAndroidNoteContaining(android, marker);
}

export async function androidFollowsPeerRenameWhileOpen(desktop, android, server) {
  await desktop.connectSync(server.url, server.password);
  await android.connectSync(server.url, server.password);
  await desktop.pauseAutoSync();

  const oldId = `${HARNESS_NOTE_PREFIX}rename-open`;
  const newId = `${HARNESS_NOTE_PREFIX}renamed-open`;
  const base = '# rename while open\nbase text';
  await desktop.writeNote(oldId, base);
  await desktop.syncNow();
  await android.waitForNoteContent(oldId, base);

  await android.openNoteInEditor(oldId);
  await android.focusOpenEditor();

  await desktop.moveNote(oldId, newId);
  await desktop.syncNow();
  await android.waitForNoteMissing(oldId);
  await android.waitForNoteContent(newId, base);
  await android.waitForOpenEditorTitle(newId);
  await android.waitForOpenEditorContent(base);

  const editedAfterRename = '# rename while open\n\nedited after rename\n';
  await android.replaceOpenEditorContent(editedAfterRename);
  await android.waitForNoteContent(newId, editedAfterRename);
  assert(!android.noteExists(oldId), 'editing after a peer rename must not resurrect old id');

  await waitForDesktopNoteContent(desktop, newId, editedAfterRename);
  assert(!(await desktop.noteExists(oldId)), 'desktop should keep the old id deleted');
}

export async function androidConflictsWithDesktopEdit(desktop, android, server) {
  await desktop.connectSync(server.url, server.password);
  await android.connectSync(server.url, server.password);

  const base = '# shared\nbase text';
  await desktop.writeNote(ANDROID_SHARED_NOTE, base);
  await desktop.syncNow();
  await android.waitForNoteContent(ANDROID_SHARED_NOTE, base);

  // The phone goes offline for real (airplane mode). Backgrounding alone is not
  // an offline window: an SSE pull already in flight lands after `pauseLive`, so
  // the phone fast-forwards to the desktop's version and edits on top of it —
  // there is no conflict left to resolve (observed).
  await android.goOffline();

  const androidText = '# shared\n\nedited on the phone while offline\n';
  await android.editNoteViaEditor(ANDROID_SHARED_NOTE, androidText);

  const desktopText = '# shared\ndesktop got there first';
  await desktop.writeNote(ANDROID_SHARED_NOTE, desktopText);
  await desktop.syncNow();

  // Back online, the phone's live loop reconnects on its own and runs a
  // push-first cycle: its offline edit loses the race, so it must survive as a
  // conflict copy instead of being overwritten.
  await android.goOnline();

  await android.waitForNoteContent(ANDROID_SHARED_NOTE, desktopText);
  const conflictId = await waitForAndroidConflictCopy(android, ANDROID_SHARED_NOTE, androidText);

  // Both clients converge on the same pair of notes.
  await waitForDesktopNoteContent(desktop, conflictId, androidText);
  await waitForDesktopNoteContent(desktop, ANDROID_SHARED_NOTE, desktopText);
}

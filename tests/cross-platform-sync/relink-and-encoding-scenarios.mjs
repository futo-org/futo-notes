/**
 * Scenarios: relinking the open note on rename, and notes that are not UTF-8.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from '../lib/mcp-client.mjs';
import { conflictCopiesOf } from './peer-edit-copy-scenarios.mjs';
import {
  assert,
  assertEqual,
  waitForEditorContent,
  waitForOpenNoteState,
  waitForSaveIdle,
} from './waits-and-assertions.mjs';

/** Rename a sidebar row the way a user does: double-click it, replace the
 * inline field's text, press Enter. Synthetic DOM events in the webview only. */
async function renameSidebarRow(client, rowSelector, inputTestId, value) {
  return client._executeMutation(
    `(async () => {
      const row = document.querySelector(${JSON.stringify(rowSelector)});
      if (!row) throw new Error('sidebar row not found: ' + ${JSON.stringify(rowSelector)});
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      const selector = '[data-testid="${inputTestId}"]';
      let input = null;
      for (let i = 0; i < 100 && !input; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        input = document.querySelector(selector);
      }
      if (!(input instanceof HTMLInputElement)) throw new Error('rename field did not open');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      for (let i = 0; i < 250 && document.querySelector(selector); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (document.querySelector(selector)) throw new Error('rename field did not close');
      return true;
    })()`,
    'renameSidebarRow',
  );
}

async function relinkOfTheOpenNote(b, variant) {
  const tag = variant.replace(/[^a-z]+/g, '');
  const hub = `relink hub ${tag}`;
  let before;
  let after;
  let rename;
  if (variant === 'note rename') {
    const target = `relink target ${tag}`;
    before = `see [[${target}]] here`;
    after = `see [[${target} moved]] here`;
    await b._executeMutation(
      `window.__testNotes.createNote(${JSON.stringify(target)}, 'target body')`,
      'createNote',
    );
    rename = () =>
      renameSidebarRow(
        b,
        `button.note-row[data-note-id=${JSON.stringify(target)}]`,
        'note-rename-input',
        `${target} moved`,
      );
  } else if (variant === 'folder rename') {
    // The open note is OUTSIDE the renamed folder; only its link points in.
    before = `see [[relinkbox${tag}/relink filed]] here`;
    after = `see [[relinkcrate${tag}/relink filed]] here`;
    await b._executeMutation(
      `window.__testNotes.createNote(${JSON.stringify(`relinkbox${tag}/relink filed`)}, 'filed')`,
      'createNote',
    );
    rename = () =>
      renameSidebarRow(
        b,
        `[data-folder-path=${JSON.stringify(`relinkbox${tag}`)}]`,
        'folder-rename-input',
        `relinkcrate${tag}`,
      );
  } else if (variant === 'projected move') {
    // A move that only projects (no save lock): the app's own moveNote.
    const mover = `relink mover ${tag}`;
    before = `see [[${mover}]] here`;
    after = `see [[relinkdest${tag}/${mover}]] here`;
    await b._executeMutation(
      `window.__testNotes.createNote(${JSON.stringify(mover)}, 'mover')`,
      'createNote',
    );
    rename = () =>
      b._executeMutation(
        `window.__testNotes.moveNoteWithCollisions(${JSON.stringify(mover)}, ${JSON.stringify(`relinkdest${tag}/${mover}`)})`,
        'moveNoteWithCollisions',
      );
  } else {
    throw new Error(`unknown variant ${variant}`);
  }
  await b._executeMutation(
    `window.__testNotes.createNote(${JSON.stringify(hub)}, ${JSON.stringify(before)})`,
    'createNote',
  );
  await b.openNote(hub);
  await waitForEditorContent(b, before);

  await rename();
  const onDisk = await b.readNote(hub);
  assertEqual(onDisk, after, `[${variant}] the rename relinks the open note on disk`);
  let adopted = false;
  for (let i = 0; i < 30 && !adopted; i += 1) {
    adopted = (await b.getOpenNoteState()).editorContent === after;
    if (!adopted) await sleep(100);
  }
  await b.focusEditor();
  await b.typeInEditor(' typed word');
  await b.flushSave();
  await waitForSaveIdle(b);
  await sleep(500);
  const copies = await conflictCopiesOf(b, hub);
  const saved = await b.readNote(hub);
  console.log(
    `    [${variant}] adopted=${adopted} disk=${JSON.stringify(saved)} copies=${JSON.stringify(copies)}`,
  );
  assertEqual(copies.length, 0, `[${variant}] a relink minted ${JSON.stringify(copies)}`);
  assert(saved.includes('typed word'), `[${variant}] the typed word must land in the note`);
  assert(saved.includes(after.slice(4, -5)), `[${variant}] the rewritten link survives the save`);
  assert(adopted, `[${variant}] the editor shows the rewritten link before the user types`);
  assertEqual(
    (await b.getOpenNoteState()).originalId,
    hub,
    `[${variant}] the editor stays on the note`,
  );
}

async function titleRenameRelinkingItsOwnLink(b) {
  // The editor's own title rename rewrites the note's self-link after writing
  // the draft; the session recorded the draft it sent as its baseline.
  const journal = 'relink journal';
  const diary = 'relink diary';
  await b._executeMutation(
    `window.__testNotes.createNote(${JSON.stringify(journal)}, ${JSON.stringify(`back to [[${journal}]]`)})`,
    'createNote',
  );
  await b.openNote(journal);
  await waitForEditorContent(b, `back to [[${journal}]]`);
  await b.focusEditor();
  await b.setTitle(diary);
  await b.flushSave();
  await waitForOpenNoteState(b, 'follow the title rename', (state) => state.originalId === diary);
  assertEqual(await b.readNote(diary), `back to [[${diary}]]`, 'the rename relinks the self-link');
  let adopted = false;
  for (let i = 0; i < 30 && !adopted; i += 1) {
    adopted = (await b.getOpenNoteState()).editorContent === `back to [[${diary}]]`;
    if (!adopted) await sleep(100);
  }
  await b.typeInEditor(' typed word');
  await b.flushSave();
  await waitForSaveIdle(b);
  await sleep(500);
  const copies = await conflictCopiesOf(b, diary);
  const saved = await b.readNote(diary);
  console.log(
    `    [self link] adopted=${adopted} disk=${JSON.stringify(saved)} copies=${JSON.stringify(copies)}`,
  );
  assertEqual(copies.length, 0, `[self link] a title rename minted ${JSON.stringify(copies)}`);
  assert(saved.includes('typed word'), '[self link] the typed word must land in the note');
  assert(saved.includes(`[[${diary}]]`), '[self link] the rewritten self-link survives the save');
  assert(adopted, '[self link] the editor shows the rewritten self-link');
}

export async function renameRelinkingTheOpenNoteDoesNotPark(_a, b) {
  // Renaming a note the open note links to — or a folder it links into, or
  // the open note itself when it links to itself — rewrites the open note's
  // file behind the editor (the store suppresses the watcher for its own
  // writes). The editor kept its pre-rename baseline, so the next keystroke's
  // save parked "<note> (conflict D)" for a conflict nobody made and the typed
  // word was missing from the note. The open note adopts the rewritten file.
  const failures = [];
  for (const variant of ['note rename', 'folder rename', 'projected move', 'self link']) {
    try {
      if (variant === 'self link') await titleRenameRelinkingItsOwnLink(b);
      else await relinkOfTheOpenNote(b, variant);
    } catch (error) {
      console.log(`    [${variant}] FAIL ${error.message}`);
      failures.push(`[${variant}] ${error.message}`);
    }
  }
  assertEqual(failures.length, 0, `relink variants failed: ${failures.join(' | ')}`);
}

export async function aNoteThatIsNotUtf8NeverOpensBlank(_a, b) {
  // A note another editor saved in Latin-1 exists in the vault. Opening it must
  // not show a blank page (every save would then fail and the note could not
  // be left); the read failure takes the loader's designed path — back home,
  // nothing created. A rename of a note it links to leaves its bytes alone
  // (re-encoding them destroyed every byte that was not UTF-8).
  const latin = Buffer.from('caf\xe9 [[latin target]]', 'latin1');
  const name = 'latin note';
  await b._executeMutation(
    `window.__testNotes.createNote('latin target', 'target body')`,
    'createNote',
  );
  writeFileSync(join(b.notesDir, `${name}.md`), latin);
  await b._executeMutation(
    `window.location.hash = '#/note/${encodeURIComponent(name)}'`,
    'open latin note',
  );
  await sleep(1500);
  const state = await b.getOpenNoteState();
  console.log(`    [latin] after open: ${JSON.stringify(state)}`);
  assert(state.originalId !== name, `a note that cannot be read opened as a blank page`);
  assert(
    readFileSync(join(b.notesDir, `${name}.md`)).equals(latin),
    'opening the note changed its bytes',
  );

  await b.moveNote('latin target', 'latin target moved');
  const bytes = readFileSync(join(b.notesDir, `${name}.md`));
  assert(bytes.equals(latin), `a relink re-encoded the note: ${JSON.stringify([...bytes])}`);
}

// Checks for behaviours of earlier editors the maintainer asked to rule out in this one,
// run against this worktree's `just tauri-dev` like the story files.
// `node tests/desktop-editor-ledger-checks.mjs [filter]` runs the checks whose name holds it.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  act,
  devVault,
  finish,
  inScratchNote,
  lines,
  onRow,
  read,
  scrollAtRest,
  story,
  until,
  untilIdle,
} from './lib/desktop-editor-story.mjs';

const selection = () => {
  const editor = read('state').editor;
  assert.equal(editor.error, undefined);
  return [editor.selection.from, editor.selection.to];
};
const shown = (text) => read('show', { text }).rect;
/** The body's textbox under the middle of the note pane (`elements` leaves out a box taller
 *  than the window). */
const editorBox = () =>
  read('at', { x: 500, y: 350 }).stack.find(
    (element) => element.role === 'textbox' && element.component === 'DesktopEditor.svelte',
  ).rect;
/** The note pane the body scrolls in: as tall as the `main` it fills. */
const paneOf = (box) =>
  read('at', { x: box.x + 10, y: 300 }).stack.find((element) => element.role === 'main').rect;
/** The line element `text` draws in, and whether a highlight band lies under it. */
function lineUnder(text) {
  const rect = shown(text);
  const stack = read('at', { x: rect.x + 1, y: rect.y + rect.h / 2 }).stack;
  return {
    line: stack[0].rect,
    highlighted: stack.some((element) => element.flags.includes('passes') && element.rect.h < 100),
  };
}
const rows = (count) => Array.from({ length: count }, (_, index) => `row ${index + 1}.`).join('\n');

/** A rect lies inside the pane, give or take a pixel. */
function insidePane(rect, pane, message) {
  assert.ok(
    rect.y >= pane.y - 1 && rect.y + rect.h <= pane.y + pane.h + 1,
    `${message}: ${rect.y}..${rect.y + rect.h} outside the pane ${pane.y}..${pane.y + pane.h}`,
  );
}

/** A long scratch note scrolled to its middle, the caret on a row in view. */
async function scrolledLongNote() {
  act('type', { text: rows(80) });
  await untilIdle();
  act('do', 'PlaceCaret', { at: 0 });
  const box = editorBox();
  await scrollAtRest({ x: box.x + box.w / 2, y: 300, dy: -6000 });
  await scrollAtRest({ x: box.x + box.w / 2, y: 300, dy: 600 });
  // Right of the row: the caret at its end.
  const row = shown('row 30.');
  act('click', { x: row.x + row.w + 20, y: row.y + row.h / 2 });
  return { box, pane: paneOf(box) };
}

// Cmd+A itself is the Edit menu's Select All, which Puppet's keys cannot reach (they go to
// the unactivated web view, not AppKit's menu): `press Mod-a` there selects nothing. These
// select the whole note through the engine instead and check what follows from it.
const selectAll = () => act('do', 'Select', { from: 0, to: read('doc').lines.at(-1).end });

await story('SV01 selecting the whole of a scrolled long note keeps the scroll', () =>
  inScratchNote(async () => {
    await scrolledLongNote();
    const before = editorBox().y;
    selectAll();
    assert.deepEqual(selection(), [0, read('doc').lines.at(-1).end]);
    assert.equal(editorBox().y, before, 'selecting everything moved the scroll');
  }),
);

await story('CS08 a whole-note highlight reaches the first and last rows in the pane', () =>
  inScratchNote(async () => {
    const { pane } = await scrolledLongNote();
    selectAll();
    const inView = read('doc').lines.filter((line) => {
      try {
        const rect = shown(line.text);
        return rect.y >= pane.y && rect.y + rect.h <= pane.y + pane.h;
      } catch {
        return false;
      }
    });
    for (const line of [inView[0], inView.at(-1)]) {
      assert.ok(lineUnder(line.text).highlighted, `no highlight band under "${line.text}"`);
    }
  }),
);

await story('CS08 a whole-note highlight in a short note covers its first row', () =>
  inScratchNote(async () => {
    act('type', { text: 'first line\n\nsecond line' });
    selectAll();
    assert.ok(lineUnder('first').highlighted, 'no highlight band under the first row');
    assert.ok(lineUnder('second').highlighted, 'no highlight band under the last row');
  }),
);

// The engine's rule (portable-core/block-commands.md): the heading becomes text, the line stays.
await story('HG02 Backspace at a heading start, under body text, joins it to that line', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: 'body\n# Title' });
    act('do', 'PlaceCaret', { at: 5 });
    act('press', { key: 'Backspace' });
    assert.deepEqual(lines(), [['paragraph', 'bodyTitle']]);
    await untilIdle();
    assert.deepEqual(
      read('file', { noteId, save: false }).lines.map((line) => line.text),
      ['bodyTitle'],
    );
  }),
);

await story('HG02 Backspace at a heading start at the note start changes nothing', () =>
  inScratchNote(async () => {
    act('type', { text: '# Title' });
    act('do', 'PlaceCaret', { at: 0 });
    act('press', { key: 'Backspace' });
    assert.deepEqual(lines(), [['heading1', 'Title']]);
  }),
);

await story('HG02 Backspace in an empty heading makes it a paragraph', () =>
  inScratchNote(async () => {
    act('type', { text: 'above\n# x' });
    act('press', { key: 'Backspace' });
    assert.deepEqual(lines()[1], ['heading1', '']);
    act('press', { key: 'Backspace' });
    // An empty body line reads as a gap.
    assert.deepEqual(lines(), [
      ['paragraph', 'above'],
      ['gap', ''],
    ]);
  }),
);

await story('SV04 typing at the bottom of a long note keeps the typed line in the pane', () =>
  inScratchNote(async () => {
    act('type', { text: rows(60) });
    await untilIdle();
    const pane = paneOf(editorBox());
    for (let line = 1; line <= 8; line++) {
      // Checked straight after the keys, before any save: no debounce may hold the scroll.
      act('type', { text: `\ntyped ${line}` });
      insidePane(shown(`typed ${line}`), pane, `typed line ${line}`);
    }
  }),
);

await story('CS10 a heading line is as tall empty as with one character', () =>
  inScratchNote(async () => {
    act('type', { text: 'above\n# x' });
    const withCharacter = lineUnder('x').line;
    act('press', { key: 'Backspace' });
    assert.deepEqual(lines()[1], ['heading1', '']);
    const empty = read('at', { x: withCharacter.x + 2, y: withCharacter.y + 2 }).stack[0].rect;
    assert.equal(empty.y, withCharacter.y, 'the empty heading line moved');
    assert.equal(
      empty.h,
      withCharacter.h,
      `heading line ${withCharacter.h}px with "x", ${empty.h}px empty`,
    );
  }),
);

/** The drawn caret (wrapper px) lies inside `text`'s line and inside the pane. */
function caretInsideLine(text, pane, message) {
  const wrapper = editorBox();
  const caret = read('state').editor.caret;
  assert.ok(caret, `${message}: no caret drawn`);
  const { line } = lineUnder(text);
  const top = wrapper.y + caret.top;
  assert.ok(
    top >= line.y - 1 && top + caret.height <= line.y + line.h + 1,
    `${message}: caret ${top}..${top + caret.height}, line ${line.y}..${line.y + line.h}`,
  );
  insidePane({ y: top, h: caret.height }, pane, message);
}

await story('CS10 the caret is not clipped above an H1 at the top, nor on the line after it', () =>
  inScratchNote(async () => {
    act('type', { text: '# Title' });
    const pane = paneOf(editorBox());
    act('do', 'PlaceCaret', { at: 0 });
    caretInsideLine('Title', pane, 'caret before the H1');
    act('do', 'PlaceCaret', { at: 5 });
    act('press', { key: 'Enter' });
    act('type', { text: 'next' });
    act('press', { key: 'ArrowLeft', count: 4 });
    caretInsideLine('next', pane, 'caret on the line after the H1');
  }),
);

await story('SV02 switching tabs away and back keeps the scroll', () =>
  inScratchNote(async (noteId) => {
    await scrolledLongNote();
    const before = editorBox().y;
    onRow('OpenNote', { noteId: 'another note', mode: 'foreground' });
    act('do', 'ActivateTab', { noteId });
    await untilIdle();
    try {
      assert.equal(editorBox().y, before, 'scroll after switching tabs back');
    } finally {
      act('do', 'CloseTabAt', { noteId: 'another note' });
    }
  }),
);

await story('SV07 Undo, Redo and a paste keep the scroll near the caret, not the bottom', () =>
  inScratchNote(async () => {
    const { pane } = await scrolledLongNote();
    const before = editorBox().y;
    act('type', { text: 'x' });
    act('press', { key: 'Mod-z' });
    insidePane(shown('row 30.'), pane, 'after Undo');
    act('press', { key: 'Shift-Mod-z' });
    insidePane(shown('row 30.x'), pane, 'after Redo');
    act('clipboard', { text: 'pasted' });
    act('do', 'Paste');
    insidePane(shown('pasted'), pane, 'after Paste');
    assert.ok(Math.abs(editorBox().y - before) < 40, `scroll moved ${editorBox().y - before}px`);
  }),
);

await story('SV04 a long paste at the end of a note shows the caret where it ends', () =>
  inScratchNote(async () => {
    act('type', { text: 'top' });
    act('clipboard', { text: `\n${rows(80)}` });
    act('do', 'Paste');
    const pane = paneOf(editorBox());
    insidePane(shown('row 80.'), pane, 'the pasted last line');
  }),
);

/** The note PF12 opens: as long as the Mac dev vault's "huge note" (62,003 lines), written by
 *  the check itself under a name of its own and removed after it. */
const HUGE = 'ledger large note';

/** From a note with a word selected, a click on the large note's row and, 300 ms into its
 *  opening, one on this note's row: the tab and the editor must both end on this note. */
async function opensWhileClicked(noteId) {
  act('type', { text: 'alpha beta' });
  act('click', { text: 'beta', count: 2 });
  const rowOf = (id) => read('elements').elements.find((element) => element.note === id).ref;
  const [huge, scratch] = [rowOf(HUGE), rowOf(noteId)];
  act('click', { ref: huge });
  await sleep(300);
  act('click', { ref: scratch });
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = read('state');
    if (state.editor?.ready && !state.editor.loading && state.note?.id !== HUGE) break;
    await sleep(100);
  }
  const state = read('state');
  assert.equal(state.screen, `editor:${noteId}`);
  assert.equal(
    state.note?.id,
    noteId,
    `the tab says ${state.screen}, the editor shows "${state.note?.id}"`,
  );
}

await story('PF12 a click on another note while a large note opens lands on that note', () =>
  inScratchNote(async (noteId) => {
    const hugePath = join(devVault(), `${HUGE}.md`);
    writeFileSync(
      hugePath,
      Array.from({ length: 62003 }, (_, index) => `row ${index + 1} of a large note`).join('\n'),
    );
    try {
      await until(() => read('notes').notes.includes(HUGE), 'the large note in the vault', 10000);
      await opensWhileClicked(noteId);
    } finally {
      rmSync(hugePath, { force: true });
    }
  }),
);

finish('desktop editor ledger checks');

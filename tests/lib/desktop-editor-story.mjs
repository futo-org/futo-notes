// The desktop editor stories' harness: real input through `just puppet` into this worktree's
// running `just tauri-dev`, checked against Puppet's JSON reads and the file on disk. A story
// file runs the stories whose name holds its first argument.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const filter = process.argv[2]?.toLowerCase();
const results = [];

/** A verb, gesture or read; a refusal exits non-zero and throws with the CLI's own words. */
export function puppet(command, ...args) {
  try {
    return execFileSync('just', ['puppet', command, ...args], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`just puppet ${command} ${args.join(' ')}\n${error.stdout ?? ''}`, {
      cause: error,
    });
  }
}

export const read = (command, args = {}) =>
  JSON.parse(puppet(command, JSON.stringify({ ...args, json: true })));
/** `act('do', 'Verb', {args})`, `act('type', {text})`: strings pass as they are. */
export const act = (command, ...args) =>
  puppet(command, ...args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))));
export const lines = () => read('doc').lines.map((line) => [line.kind, line.text]);
/** A verb on a note's sidebar row, reached first as a person would: with a small window or
 *  a long vault the row is below the sidebar's fold, and Puppet refuses a row it cannot see. */
export const onRow = (verb, args) =>
  act('do', [
    ['ScrollToRow', { noteId: args.noteId }],
    [verb, args],
  ]);

/** Every edit acknowledged and written, the title's rename included: the editor's idle signal
 *  covers the body alone, and a title's rename runs in the note session's save queue (its
 *  `pending.unsaved`) once the field's blur and the pointer's release have run. Given up
 *  within 5 s, well before the title's 10 s save timer, so a blur that never saved fails
 *  instead of passing on the timer. */
export async function untilIdle() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = read('state');
    if (state.editor.idle && state.pending.unsaved.length === 0) return;
    await sleep(100);
  }
  throw new Error('the editor never went idle: edits not acknowledged or not saved');
}

/** `check()`'s answer once it is truthy, within 3 s (or `milliseconds`): for what the editor
 *  draws on its next frame (the highlight, the selection toolbar), which a background window can
 *  hold back. */
export async function until(check, what, milliseconds = 3000) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const answer = check();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    await sleep(50);
  }
}

/** A wheel scroll at `args`'s point, once the pane under it is at rest: WebKitGTK animates a
 *  wheel's scroll and lands it after the receipt. At rest is two reads 50 ms apart that agree. */
export async function scrollAtRest(args) {
  act('scroll', args);
  const textboxTop = () =>
    read('at', { x: args.x, y: args.y }).stack.find((element) => element.role === 'textbox')?.rect
      .y;
  let last = textboxTop();
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await sleep(50);
    const top = textboxTop();
    if (top === last) return;
    last = top;
  }
  throw new Error('never happened: the pane at rest after a wheel scroll');
}

export async function story(name, run) {
  if (filter && !name.toLowerCase().includes(filter)) return;
  const started = Date.now();
  try {
    await run();
    results.push(true);
    console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    results.push(false);
    console.log(`  ✗ ${name}\n${error.stack ?? error}`);
  }
}

/** AppKit's Ctrl keys (editing.md): elsewhere Ctrl is Mod, so Ctrl+T opens a tab and Ctrl+Q quits. */
export const appleStory = process.platform === 'darwin' ? story : async () => {};

const apple = process.platform === 'darwin';

/** The key that puts the caret at the note's end: Cmd+Down on a Mac, where Cmd+End moves
 *  nothing, Ctrl+End elsewhere, where Ctrl+Down moves by paragraph. */
export const NOTE_END_KEY = apple ? 'Mod-ArrowDown' : 'Mod-End';
/** The same key extending the selection there. */
export const SELECT_TO_NOTE_END_KEY = `Shift-${NOTE_END_KEY}`;

/** A format shortcut's key held with Shift, which is no shortcut. Off a Mac Shift+Ctrl+I opens
 *  a debug build's web inspector, which takes the bottom of the window from every later story. */
export const SHIFTED_FORMAT_KEY = apple ? 'Shift-Mod-i' : 'Shift-Mod-e';

/** A note of its own, deleted afterwards through its menu as a person would. */
export async function inNewNote(run) {
  act('do', 'CreateNote');
  const noteId = read('state').note.id;
  // The app focuses the body on the next frame, which a background window may not draw:
  // put the caret there as a click would.
  act('do', 'PlaceCaret', { at: 0 });
  try {
    await run(noteId);
  } finally {
    const current = read('state').note?.id ?? noteId;
    onRow('OpenNoteContextMenu', { noteId: current });
    act('do', 'DeleteNote');
    act('do', 'ConfirmDialog');
  }
}

/** The engine's selection as [from, to]; Puppet's mismatch error fails the story. */
export function selection() {
  const editor = read('state').editor;
  assert.equal(editor.error, undefined);
  return [editor.selection.from, editor.selection.to];
}

/** A note of its own, deleted afterwards. Unlike `inNewNote` it deletes only that note. */
export async function inScratchNote(run) {
  act('do', 'CreateNote');
  const noteId = read('state').note.id;
  act('do', 'PlaceCaret', { at: 0 });
  try {
    await run(noteId);
  } finally {
    // Through another note: a lost switch can leave `screen` naming the scratch note.
    if (read('state').note?.id !== noteId) {
      onRow('OpenNote', { noteId: 'another note' });
      onRow('OpenNote', { noteId });
    }
    // Never deletes another note; a scratch note it cannot get back to is left in the vault.
    if (read('state').note?.id === noteId) {
      onRow('OpenNoteContextMenu', { noteId });
      act('do', 'DeleteNote');
      act('do', 'ConfirmDialog');
    } else {
      console.error(`could not get back to "${noteId}": not deleting "${read('state').note?.id}"`);
    }
  }
}

/** The vault the running dev app of this checkout reads (the folder `scripts/tauri-dev.mjs`
 *  names in `.tauri-data/notes-dir-override.json`); never the user's real one. */
export function devVault() {
  const overridePath = join(
    import.meta.dirname,
    '..',
    '..',
    '.tauri-data',
    'notes-dir-override.json',
  );
  const { notesDir } = JSON.parse(readFileSync(overridePath, 'utf8'));
  if (resolve(notesDir) === join(homedir(), 'Documents', 'futo-notes')) {
    throw new Error(`Dev vault is the real vault: ${notesDir}`);
  }
  return notesDir;
}

// Display lines: "Head big lean old mono" 0..22, "plain bold ital gone code and both end"
// 23..61, "a plain line" 62..74.
/** A heading, a line of every inline format and a plain line, for the format and heading
 *  stories. */
export const FORMATS_NOTE = [
  '# Head **big** *lean* ~~old~~ `mono`',
  'plain **bold** *ital* ~~gone~~ `code` and ***both*** end',
  'a plain line',
].join('\n');

/** Where `text` shows on screen (`show {"text"}`): its box, positions and formats. */
export const shownText = (text) => read('show', { text });
/** The viewport y of the middle of where `text` shows. */
export const rowMiddleOf = (text) => shownText(text).rect.y + shownText(text).rect.h / 2;

/** The line element and the highlight bands under a point (bands pass the pointer through). */
export function lineAndBandsAt(x, y) {
  const stack = read('at', { x, y }).stack;
  return {
    line: stack[0].rect,
    bands: stack
      .filter((element) => element.flags.includes('passes') && element.rect.h < 100)
      .map((element) => JSON.stringify(element.rect)),
  };
}

/** `actual` within a pixel of `expected`: boxes meet at fractional pixels. */
export const assertNear = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual} ≠ ${expected}`);

/** Paste `markdown` at the caret, through the agent's clipboard. */
export function pasted(markdown) {
  act('clipboard', { text: markdown });
  act('do', 'Paste');
}

/** Paste `markdown`, which ends with a code block, as a note that ends with that block: a
 *  paste opens an empty line under a block that would end the note, and Backspace on that line
 *  takes it away again (and leaves the block selected). */
export function pastedEndingWithBlock(markdown) {
  pasted(markdown);
  act('press', { key: 'Backspace' });
}

/** Print the tally and set the exit code: `label` names the file's stories. */
export function finish(label) {
  const failed = results.filter((pass) => !pass).length;
  console.log(`${results.length - failed}/${results.length} ${label} passed`);
  process.exitCode = failed ? 1 : 0;
}

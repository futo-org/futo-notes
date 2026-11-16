#!/usr/bin/env node
/**
 * The native iOS editor's whole editing loop, driven only through `just puppet` against this
 * worktree's claimed simulator (#431). Real keys go through `type` and `press`, real touches
 * through `tap`; the oracle is the note's source text read from the simulator's disk, never
 * puppet's own account of what it did. Each convenience verb is run beside the tap it stands
 * for, from the same starting state, and must land in the same source, selection and undo
 * state (and, for a link, the same screen).
 *
 * Typed text is lowercase: a capital sent through the simulator's key input leaves Shift held
 * for every key after it (papercut pc_7e2c60a86250). The keyboard still capitalizes a
 * sentence's first letter, as it does for a person, so the expected text does too.
 *
 * Usage (or `just test-ios-editor-stories`, which builds and launches the app first):
 *   eval "$(just qa-claim ios)"
 *   just ios-native
 *   node tests/ios-editor-stories.mjs
 *   node tests/ios-editor-stories.mjs --story toolbar   # the stories up to the first named
 *                                                       # "…toolbar…" (each builds on the last)
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// This worktree's claimed simulator, the one `just puppet` drives: never "whatever is booted".
const SIM = process.env.SIM;
if (!SIM) {
  console.error('SIM is not set: eval "$(just qa-claim ios)" first');
  process.exit(2);
}
const env = { ...process.env, FUTO_PUPPET_TARGET: 'ios' };
// Digits: the keyboard autocorrects a random word typed into a wikilink (`psvpv` → `Pavlov`).
const run = String(Date.now()).slice(-6);
const NOTE_A = `pstory a ${run}`;
const NOTE_B = `pstory b ${run}`;

class StepFailure extends Error {}

/** One `just puppet` call with `{"json":true}`; refusals come back as data, not throws. */
function puppet(command, args) {
  const argv = ['puppet', command];
  if (args !== undefined) argv.push(JSON.stringify({ ...args, json: true }));
  else argv.push('{"json":true}');
  const out = spawnSync('just', argv, { cwd: repoRoot, env, encoding: 'utf8' });
  const text = out.stdout.trim();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new StepFailure(`puppet ${command} printed no JSON: ${text || out.stderr.trim()}`);
  }
  return body;
}

/** One verb (or a batch); throws unless every step answered 200. */
function act(verb, args = {}) {
  const out = spawnSync('just', ['puppet', 'do', verb, JSON.stringify({ ...args, json: true })], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  let receipts;
  try {
    receipts = JSON.parse(out.stdout);
  } catch {
    throw new StepFailure(`do ${verb} printed no JSON: ${out.stdout}${out.stderr}`);
  }
  const last = receipts.at(-1);
  if (last.status !== 200) {
    throw new StepFailure(
      `do ${verb} ${JSON.stringify(args)} → ${last.status}: ${last.result?.error}`,
    );
  }
  return last.result;
}

/** A real gesture (`tap`, `type`, `press`); throws on a refusal. */
function gesture(name, args) {
  const body = puppet(name, args);
  if (body.ok === false || body.error) {
    throw new StepFailure(`${name} ${JSON.stringify(args)} refused: ${body.error}`);
  }
  return body;
}

function state() {
  return puppet('state', {});
}

function editor() {
  const current = state().editor;
  if (!current?.ready) throw new StepFailure(`no ready editor: ${JSON.stringify(current)}`);
  return current;
}

/** The on-screen element whose role matches and whose text is `text` (or starts with it, for
 * a suggestion whose row also reads its folder), as `elements` lists it. */
function element(role, text) {
  const { elements } = puppet('elements', {});
  const found = elements.filter(
    (e) => e.role === role && (e.text === text || e.text.startsWith(`${text},`)),
  );
  if (found.length !== 1) {
    const shown = elements.map((e) => `${e.role} ${JSON.stringify(e.text)}`).join(', ');
    throw new StepFailure(
      `${found.length} ${role} elements read ${JSON.stringify(text)}; on screen: ${shown}`,
    );
  }
  return found[0];
}

function tapElement(role, text) {
  const { ref } = element(role, text);
  return gesture('tap', { ref });
}

/** The note's file on the simulator's disk, after `file` has saved the open note. */
function saved(noteId) {
  const answer = puppet('file', { noteId });
  if (answer.ok === false) throw new StepFailure(`file ${noteId}: ${answer.error}`);
  const container = spawnSync(
    'xcrun',
    ['simctl', 'get_app_container', SIM, 'com.futo.notes.dev', 'data'],
    { encoding: 'utf8' },
  ).stdout.trim();
  const disk = readFileSync(join(container, 'Documents', 'fake-notes', `${noteId}.md`), 'utf8');
  return disk.endsWith('\n') && !disk.endsWith('\n\n') ? disk.slice(0, -1) : disk;
}

function expectSaved(noteId, expected, step) {
  const actual = saved(noteId);
  if (actual !== expected) {
    throw new StepFailure(
      `${step}: expected ${JSON.stringify(expected)} on disk, found ${JSON.stringify(actual)}`,
    );
  }
}

function expectEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new StepFailure(`${what}: expected ${e}, found ${a}`);
}

/** What a convenience verb and its tap must agree on. */
function outcome(noteId) {
  const current = editor();
  return {
    source: saved(noteId),
    selection: { from: current.selection.from, to: current.selection.to },
    canUndo: current.canUndo,
    canRedo: current.canRedo,
  };
}

/** Undo with the verb until the note reads `source` again. */
function undoTo(noteId, source) {
  for (let i = 0; i < 6 && saved(noteId) !== source; i++) act('Undo');
  expectSaved(noteId, source, 'undo back to the starting state');
}

/** Puts the caret at the end of the note. */
function caretAtEnd() {
  act('PlaceCaret', { at: puppet('doc', {}).text.length });
}

// MARK: stories

const stories = [];
const story = (name, fn) => stories.push({ name, fn });

story('create a note and type with real keys', () => {
  // Start from the note list, wherever an earlier run left the app.
  for (let i = 0; i < 4 && state().screen !== 'list'; i++) act('GoBack');
  act('CreateNote');
  act('SetTitle', { title: NOTE_A });
  const field = puppet('elements', {}).elements.find(
    (e) => e.section === 'editor' && e.role === 'field',
  );
  if (!field) throw new StepFailure('no editor field on screen');
  gesture('tap', { ref: field.ref });
  gesture('type', { text: 'hello world' });
  gesture('press', { key: 'Enter' });
  gesture('type', { text: 'second line' });
  expectSaved(NOTE_A, 'Hello world\nSecond line', 'typed two lines');
  gesture('press', { key: 'Backspace', count: 4 });
  gesture('type', { text: 'row' });
  expectSaved(NOTE_A, 'Hello world\nSecond row', 'backspace and retype');
});

story('reads change nothing mid-edit', () => {
  act('Select', { find: 'world' });
  gesture('type', { text: 'x' });
  act('Select', { find: 'Hello' });
  const before = editor();
  const pending = state().pending.unsaved;
  if (!pending.includes(NOTE_A)) console.log('    (the typing had already saved before the reads)');
  const shown = puppet('show', { text: 'Hello' }).rect;
  for (const [read, args] of [
    ['state', {}],
    ['doc', {}],
    ['doc', { line: 2 }],
    ['actions', {}],
    ['elements', {}],
    ['show', { text: 'Hello' }],
    ['at', { x: shown.x + 2, y: shown.y + 2 }],
  ]) {
    puppet(read, args);
    const now = editor();
    expectEqual(now.docVersion, before.docVersion, `${read}: docVersion`);
    expectEqual(now.selection, before.selection, `${read}: selection`);
    expectEqual(now.canUndo, before.canUndo, `${read}: canUndo`);
    expectEqual(state().pending.unsaved, pending, `${read}: pending save`);
  }
  const doc = puppet('doc', {});
  expectEqual(doc.source, 'Hello x\nSecond row', 'doc source holds the unsaved edit');
  act('Undo');
  expectSaved(NOTE_A, 'Hello world\nSecond row', 'undo after the reads undoes the typing');
});

story('toolbar tap and toolbar verb land alike', () => {
  const start = 'Hello world\nSecond row';
  act('Select', { find: 'world' });
  const bold = element('button', 'Bold');
  const under = puppet('at', {
    x: bold.rect.x + bold.rect.w / 2,
    y: bold.rect.y + bold.rect.h / 2,
  });
  expectEqual(under.element?.text, 'Bold', 'at names the toolbar button under the point');
  tapElement('button', 'Bold');
  const tapped = outcome(NOTE_A);
  expectEqual(tapped.source, 'Hello **world**\nSecond row', 'Bold tapped');
  undoTo(NOTE_A, start);
  act('Select', { find: 'world' });
  act('Bold');
  expectEqual(outcome(NOTE_A), tapped, 'do Bold against the Bold tap');
  tapElement('button', 'Undo');
  expectSaved(NOTE_A, start, 'Undo tapped');
  tapElement('button', 'Redo');
  expectSaved(NOTE_A, 'Hello **world**\nSecond row', 'Redo tapped');
  act('Undo');
  act('Redo');
  expectSaved(NOTE_A, 'Hello **world**\nSecond row', 'Undo then Redo by verb');
});

story('task checkbox tap and ToggleTask land alike', () => {
  const start = 'Hello **world**\nSecond row\n- [ ] chore';
  act('Insert', { after: 'Second row', text: '\n- [ ] chore' });
  expectSaved(NOTE_A, start, 'task inserted');
  act('PlaceCaret', { at: 0 });
  tapElement('checkbox', 'chore');
  const tapped = outcome(NOTE_A);
  expectEqual(tapped.source, 'Hello **world**\nSecond row\n- [x] chore', 'checkbox tapped');
  undoTo(NOTE_A, start);
  act('PlaceCaret', { at: 0 });
  act('ToggleTask', { find: 'chore' });
  expectEqual(outcome(NOTE_A), tapped, 'ToggleTask against the checkbox tap');
});

story('table cell edit and copy', () => {
  act('Insert', { after: 'chore', text: '\n\n| a1 | b1 |\n| --- | --- |\n| qq | zz |' });
  const before = saved(NOTE_A);
  const cell = puppet('show', { text: 'qq' });
  gesture('tap', { x: cell.rect.x + cell.rect.w - 2, y: cell.rect.y + cell.rect.h / 2 });
  gesture('press', { key: 'ArrowRight', count: 2 });
  gesture('type', { text: 'x' });
  expectSaved(NOTE_A, before.replace('| qq |', '| qqx |'), 'typed into the table cell');
  act('Select', { find: 'qqx' });
  act('Copy');
  expectEqual(state().editor.clipboard, 'qqx', 'copied from the cell');
  act('Select', { find: 'zz' });
  act('Paste');
  expectSaved(NOTE_A, before.replace('| qq | zz |', '| qqx | qqx |'), 'pasted into a cell');
});

story('copy and paste between notes', () => {
  act('GoBack');
  act('CreateNote');
  act('SetTitle', { title: NOTE_B });
  caretAtEnd();
  act('Paste');
  expectSaved(NOTE_B, 'qqx', 'pasted the cell text into another note');
  gesture('press', { key: 'Enter' });
});

story('wikilink suggestion tap and AcceptSuggestion land alike', () => {
  const typed = `see [[${NOTE_A}`;
  gesture('type', { text: typed });
  element('button', NOTE_A);
  const startOfTyped = saved(NOTE_B);
  tapElement('button', NOTE_A);
  const tapped = outcome(NOTE_B);
  expectEqual(tapped.source, `qqx\nSee [[${NOTE_A}]]`, 'suggestion tapped');
  undoTo(NOTE_B, startOfTyped);
  caretAtEnd();
  if (!puppet('actions', {}).actions.some((a) => a.name === 'AcceptSuggestion')) {
    gesture('type', { text: 'a' });
    gesture('press', { key: 'Backspace' });
  }
  act('AcceptSuggestion', { text: NOTE_A });
  expectEqual(outcome(NOTE_B), tapped, 'AcceptSuggestion against the suggestion tap');
});

story('link tap and OpenLink reach the same screen', () => {
  const source = saved(NOTE_B);
  tapElement('link', `[[${NOTE_A}]]`);
  const tapped = state().screen;
  expectEqual(tapped, `editor:${NOTE_A}`, 'the wikilink tap opened the note');
  act('GoBack');
  expectEqual(state().screen, `editor:${NOTE_B}`, 'back on the linking note');
  act('OpenLink', { find: NOTE_A });
  expectEqual(state().screen, tapped, 'OpenLink against the link tap');
  act('GoBack');
  expectSaved(NOTE_B, source, 'opening a link leaves the note as it was');
});

story('reopen the note', () => {
  act('GoBack');
  act('OpenNote', { noteId: NOTE_A });
  const doc = puppet('doc', {});
  expectEqual(doc.source, saved(NOTE_A), 'the reopened note shows what is on disk');
  expectSaved(
    NOTE_A,
    'Hello **world**\nSecond row\n- [x] chore\n\n| a1 | b1 |\n| --- | --- |\n| qqx | qqx |',
    'the whole loop',
  );
});

// MARK: runner

const only = process.argv.includes('--story')
  ? process.argv[process.argv.indexOf('--story') + 1]
  : null;
// A freshly launched app takes a moment to start its listener.
for (let deadline = Date.now() + 30_000; ;) {
  let answer;
  try {
    answer = state();
    if (answer.screen) break;
  } catch (error) {
    answer = error.message;
  }
  if (Date.now() > deadline) {
    console.error(`the app did not answer within 30 s: ${JSON.stringify(answer)}`);
    process.exit(1);
  }
  await new Promise((done) => setTimeout(done, 500));
}
const results = [];
let broken = null;
console.log(`iOS editor stories (notes "${NOTE_A}", "${NOTE_B}")`);
let reached = false;
for (const { name, fn } of stories) {
  if (reached) break;
  if (only && name.includes(only)) reached = true;
  if (broken) {
    results.push({ name, pass: false, error: `not run: "${broken}" failed first` });
    console.log(`  - ${name} (not run)`);
    continue;
  }
  const start = Date.now();
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ✓ ${name} (${Date.now() - start}ms)`);
  } catch (error) {
    results.push({ name, pass: false, error: error.message });
    console.log(`  ✗ ${name} (${Date.now() - start}ms)\n      ${error.message}`);
    // Each story starts from the state the previous one left: stop at the first break.
    broken = name;
  }
}
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length > 0 ? 1 : 0);

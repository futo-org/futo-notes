#!/usr/bin/env node
// A lone UTF-16 surrogate in the editor document must not hang the save (RC-48).
//
// Before the fix, `flushSave` / `writeNote` with a lone surrogate in the text never
// settled: the Tauri IPC body (JSON with a `\ud800` escape) was refused by serde on the
// Rust side and the reply was lost, so the shell waited for ever with `savePending:true`,
// every later edit went unsaved with no toast, and the note could not be left.
// Maintainer decision 16A: a lone surrogate is written as U+FFFD, and a save never hangs.
//
// Legs (each asserts the save SETTLES, the file is valid UTF-8 holding U+FFFD, and the
// note can be left):
//   store    `__testNotes.writeNote(id, '\ud800')` through the store's IPC boundary.
//   title    a title carrying a lone surrogate (the IPC's other string arguments).
//   editor   a lone surrogate typed into the open document, flushSave, more typing, leave.
//   reject   a save that fails (read-only vault) rejects, keeps the edit, and retries.
//   commands other IPC commands (read, exists, search) with a lone surrogate in an
//            argument: they settle.
//
// Runs the desktop test build (`just build-desktop-test`) on Linux under a display, e.g.
//   bash scripts/run-under-virtual-kwin.sh node tests/desktop-lone-surrogate.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, TextDecoder } from 'node:util';
import { startDesktopTauriInstance } from './lib/tauri-instance.mjs';
import { executeJs, sleep } from './lib/mcp-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    leg: { type: 'string', default: 'all' },
    'settle-ms': { type: 'string', default: '15000' },
  },
});
const settleMs = Number(args['settle-ms']);
const report = { legs: {} };

function storageWith(files) {
  const parent = process.env.FUTO_VERIFICATION_DIR || path.join(root, '.tauri-data');
  fs.mkdirSync(parent, { recursive: true });
  const instanceDir = fs.mkdtempSync(path.join(parent, 'lone-surrogate-'));
  const dataDir = path.join(instanceDir, 'data');
  const notesDir = path.join(instanceDir, 'notes');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'notes-dir-override.json'), JSON.stringify({ notesDir }));
  for (const [name, body] of Object.entries(files))
    fs.writeFileSync(path.join(notesDir, name), body);
  return { instanceDir, dataDir, notesDir };
}

async function launch(files) {
  return startDesktopTauriInstance('lone-surrogate', root, { storage: storageWith(files) });
}

function killIfAlive(client) {
  try {
    if (client?.proc && client.proc.exitCode === null) client.proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Start `expression` (a promise) in the page; poll until it settles or `ms` pass. */
async function settle(client, slot, expression, ms = settleMs) {
  await executeJs(
    client.ws,
    `(() => { window.__probe = window.__probe || {};
       Promise.resolve().then(() => ${expression}).then(
         (v) => { window.__probe[${JSON.stringify(slot)}] = { state: 'resolved', value: String(v).slice(0, 200) }; },
         (e) => { window.__probe[${JSON.stringify(slot)}] = { state: 'rejected', error: String(e && e.message || e).slice(0, 300) }; });
       return 'started'; })()`,
  );
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const got = await executeJs(
      client.ws,
      `JSON.stringify(window.__probe[${JSON.stringify(slot)}] ?? null)`,
    );
    const parsed = typeof got === 'string' ? JSON.parse(got) : got;
    if (parsed) return { ...parsed, ms: Date.now() - t0 };
    await sleep(150);
  }
  return { state: 'HUNG', ms };
}

async function shellState(client) {
  const got = await executeJs(client.ws, 'JSON.stringify(window.__notesShellTest.getState())');
  return typeof got === 'string' ? JSON.parse(got) : got;
}

/** Bytes are valid UTF-8 (throws otherwise) and hold no lone surrogate by construction. */
function readUtf8(file) {
  const bytes = fs.readFileSync(file);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function canLeave(client, toId) {
  await executeJs(client.ws, `location.hash = '#/note/${encodeURIComponent(toId)}'; 'set'`);
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    const state = await shellState(client);
    if (state.originalId === toId) return { left: true, ms: Date.now() - t0 };
    await sleep(200);
  }
  return { left: false, state: await shellState(client) };
}

async function storeLeg() {
  const client = await launch({ 'Other.md': 'Other note.\n' });
  try {
    const control = await settle(
      client,
      'control',
      `window.__testNotes.writeNote('probe control', 'fine\\n')`,
    );
    const high = await settle(
      client,
      'high',
      `window.__testNotes.writeNote('probe lone high', '\\ud800')`,
    );
    const mid = await settle(
      client,
      'mid',
      `window.__testNotes.writeNote('probe lone mid', 'a\\udc00b')`,
    );
    const pairOk = await settle(
      client,
      'pair',
      `window.__testNotes.writeNote('probe pair', 'keep \\ud83d\\ude00 pair\\n')`,
    );
    const leg = { control, high, mid, pairOk };
    for (const [id, name] of [
      ['high', 'probe lone high'],
      ['mid', 'probe lone mid'],
      ['pairOk', 'probe pair'],
    ]) {
      const file = path.join(client.notesDir, `${name}.md`);
      leg[`${id}File`] = fs.existsSync(file) ? JSON.stringify(readUtf8(file)) : null;
    }
    report.legs.store = leg;
    console.log(`store: ${JSON.stringify(leg)}`);
    assert.equal(control.state, 'resolved', 'control write must resolve');
    assert.equal(high.state, 'resolved', 'a lone high surrogate save must settle');
    assert.equal(mid.state, 'resolved', 'a lone low surrogate save must settle');
    assert.equal(leg.highFile, JSON.stringify('\uFFFD'), 'lone high surrogate written as U+FFFD');
    assert.equal(leg.midFile, JSON.stringify('a\uFFFDb'), 'lone low surrogate written as U+FFFD');
    assert.equal(leg.pairOkFile, JSON.stringify('keep \u{1F600} pair\n'));
  } finally {
    killIfAlive(client);
  }
}

async function titleLeg() {
  const client = await launch({ 'Other.md': 'Other note.\n' });
  try {
    const title = await settle(
      client,
      'title',
      `window.__testNotes.writeNote('bad \\ud800 title', 'body\\n')`,
    );
    const files = fs.readdirSync(client.notesDir);
    const leg = { title, files };
    report.legs.title = leg;
    console.log(`title: ${JSON.stringify(leg)}`);
    assert.equal(title.state, 'resolved', 'a lone surrogate in the note id must settle');
    assert.ok(
      files.some((name) => name.includes('\uFFFD')),
      'the file name holds U+FFFD',
    );
  } finally {
    killIfAlive(client);
  }
}

async function editorLeg() {
  const client = await launch({ 'Probe.md': 'Editor probe paragraph.\n', 'Other.md': 'Other.\n' });
  try {
    await client.openNote('Probe');
    // The result is JSON-escaped page-side: the test bridge cannot carry a raw lone surrogate.
    const typed = await executeJs(
      client.ws,
      `JSON.stringify(window.__notesShellTest.typeInEditor('x\\ud800y'))`,
    );
    const flush1 = await settle(client, 'flush1', 'window.__notesShellTest.flushSave()');
    const afterFlush = await shellState(client);
    const file = path.join(client.notesDir, 'Probe.md');
    const disk1 = readUtf8(file);
    await executeJs(
      client.ws,
      `JSON.stringify(window.__notesShellTest.typeInEditor(' later words'))`,
    );
    const flush2 = await settle(client, 'flush2', 'window.__notesShellTest.flushSave()');
    const disk2 = readUtf8(file);
    const left = await canLeave(client, 'Other');
    const leg = {
      typed,
      flush1,
      savePendingAfterFlush: afterFlush.savePending,
      disk1: JSON.stringify(disk1),
      flush2,
      disk2: JSON.stringify(disk2),
      left,
    };
    report.legs.editor = leg;
    console.log(`editor: ${JSON.stringify(leg)}`);
    assert.equal(flush1.state, 'resolved', 'flushSave with a lone surrogate must settle');
    assert.equal(afterFlush.savePending, false, 'savePending must clear');
    assert.ok(disk1.includes('x\uFFFDy'), 'the file holds U+FFFD where the surrogate was');
    assert.equal(flush2.state, 'resolved', 'a later flush settles');
    assert.ok(disk2.includes('later words'), 'edits after the surrogate reach disk');
    assert.equal(left.left, true, 'the note can be left');
  } finally {
    killIfAlive(client);
  }
}

// A save that FAILS (a vault that has become read-only) rejects instead of hanging, keeps the
// edit in the editor, shows the save-failure toast, and lands once the disk is writable again.
// This is the path a payload error takes now that it settles: same rejection, same toast.
async function rejectLeg() {
  const client = await launch({ 'Probe.md': 'Editor probe paragraph.\n', 'Other.md': 'Other.\n' });
  try {
    await client.openNote('Probe');
    await executeJs(client.ws, `JSON.stringify(window.__notesShellTest.typeInEditor('kept edit'))`);
    fs.chmodSync(client.notesDir, 0o555);
    const failed = await settle(client, 'failed', 'window.__notesShellTest.flushSave()');
    const during = await shellState(client);
    fs.chmodSync(client.notesDir, 0o755);
    const retried = await settle(client, 'retried', 'window.__notesShellTest.flushSave()');
    const disk = readUtf8(path.join(client.notesDir, 'Probe.md'));
    const leg = {
      failed,
      toast: during.toastMessage,
      editorKeptEdit: during.editorContent.includes('kept edit'),
      savePendingWhileFailing: during.savePending,
      retried,
      disk: JSON.stringify(disk),
    };
    report.legs.reject = leg;
    console.log(`reject: ${JSON.stringify(leg)}`);
    assert.equal(failed.state, 'rejected', 'a failing save rejects');
    assert.equal(leg.editorKeptEdit, true, 'the in-memory edit survives the failed save');
    assert.equal(retried.state, 'resolved', 'the retry settles once the disk is writable');
    assert.ok(disk.includes('kept edit'), 'the retried save wrote the edit');
  } finally {
    try {
      fs.chmodSync(client.notesDir, 0o755);
    } catch {
      /* gone */
    }
    killIfAlive(client);
  }
}

// The other commands carry ill-formed text too: a wiki-link target, a search query, a title.
// They settle (the unrepaired transport hangs for ever on any of them).
async function commandsLeg() {
  const client = await launch({ 'Other.md': 'Other note.\n' });
  try {
    const read = await settle(client, 'read', `window.__testNotes.readNote('a\\ud800b')`);
    const exists = await settle(client, 'exists', `window.__testNotes.noteExists('a\\udc00b')`);
    const search = await settle(
      client,
      'search',
      `window.__testSearch.search('q\\ud800').then((hits) => hits.length)`,
    );
    const sane = await settle(client, 'sane', `window.__testNotes.noteExists('Other')`);
    const leg = { read, exists, search, sane };
    report.legs.commands = leg;
    console.log(`commands: ${JSON.stringify(leg)}`);
    assert.equal(sane.state, 'resolved', 'the control command resolves');
    for (const [name, outcome] of Object.entries({ read, exists, search }))
      assert.notEqual(outcome.state, 'HUNG', `${name} with a lone surrogate must settle`);
  } finally {
    killIfAlive(client);
  }
}

const LEGS = {
  store: storeLeg,
  title: titleLeg,
  editor: editorLeg,
  reject: rejectLeg,
  commands: commandsLeg,
};
const wanted = args.leg === 'all' ? Object.keys(LEGS) : args.leg.split(',');
let failed = 0;
for (const name of wanted) {
  try {
    await LEGS[name]();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
console.log(JSON.stringify(report));
process.exit(failed ? 1 : 0);

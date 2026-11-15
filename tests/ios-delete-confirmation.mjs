#!/usr/bin/env node
/**
 * Real iPhone-simulator regression: a swipe Delete only presents confirmation;
 * no neighboring row moves until confirmation. Covers notes, folders and search.
 * Requires this worktree's claimed simulator, installed debug app at its root
 * list with sync disconnected, and ffmpeg. Run: just test-ios-delete-confirmation.
 * All input uses puppet. simctl only resolves the owned dev container and records
 * pixels. Fixtures live in a unique folder; recordings remain in verification-runs.
 * Not a CI gate: this needs a running native app and simulator video capture.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { POOL, readOwner, worktreeRoot } from '../scripts/qa/pool.mjs';

const root = worktreeRoot();
const claims = Array.from({ length: POOL }, (_, i) => readOwner('ios', `futo-qa-${i}`)).filter(
  (owner) => owner?.worktree === root && !owner.extra,
);
assert.equal(claims.length, 1, 'claim one simulator with just qa-claim ios');
const sim = claims[0].id;
assert(sim, 'simulator claim has no device id');
const env = { ...process.env, FUTO_PUPPET_TARGET: 'ios' };
function puppet(command, args, json = false) {
  const argv = ['puppet', command];
  if (args !== undefined) argv.push(typeof args === 'string' ? args : JSON.stringify(args));
  const output = execFileSync('just', argv, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
  if (json) return JSON.parse(output);
  process.stdout.write(output);
}
function query(command) {
  return puppet(command, { json: true }, true);
}
function act(verb, args = {}) {
  puppet('do', JSON.stringify([[verb, args]]));
}
const initial = query('state');
assert.equal(initial.screen, 'list', 'start at the root note list');
assert.equal(initial.sheet, null, 'dismiss any open sheet first');
assert.equal(initial.sync.connected, false, 'use an isolated, disconnected QA vault');
assert.deepEqual(initial.pending.unsaved, []);
execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
const container = execFileSync(
  'xcrun',
  ['simctl', 'get_app_container', sim, 'com.futo.notes.dev', 'data'],
  { encoding: 'utf8' },
).trim();
const marker = `Swipe-check-${randomUUID()}`;
const fixture = path.join(container, 'Documents/fake-notes', marker);
const evidence = path.join(root, 'verification-runs', marker);
fs.mkdirSync(fixture);
fs.mkdirSync(evidence, { recursive: true });
for (const name of [
  'Atlas',
  'Birch',
  'Cedar',
  'Delta',
  'Elm',
  'Fjord',
  'Grove',
  'Harbor',
  'Iris',
  'Juniper',
  'Kite',
  'Larch',
]) {
  fs.writeFileSync(path.join(fixture, `${name}.md`), `${marker}\n`);
}
for (const name of ['First folder', 'Second folder', 'Third folder']) {
  fs.mkdirSync(path.join(fixture, name));
  fs.writeFileSync(path.join(fixture, name, `${name} child.md`), `${marker}\n`);
}

// Normalized pixel correlation ignores the confirmation's dimming overlay. Track
// a neighboring row's title through EVERY recorded frame, including the transient
// collapse/reinsert that a settled accessibility snapshot cannot observe.
function measureMovement(video, size, anchor, range) {
  const width = Math.round(size.w),
    height = Math.round(size.h);
  const raw = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      video,
      '-vf',
      `fps=60,scale=${width}:${height}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  const x = Math.round(anchor.rect.x + 16),
    y = Math.round(anchor.rect.y + 16),
    w = 135,
    h = 24;
  assert(y - range > height * 0.6, 'tracking window must stay below the dialog');
  function patch(frame, dy) {
    const values = [];
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) values.push(frame[(y + dy + j) * width + x + i]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.map((v) => v - mean);
  }
  const reference = patch(raw.subarray(0, width * height), 0);
  const norm = Math.sqrt(reference.reduce((sum, v) => sum + v * v, 0));
  assert(norm > 100, 'tracking window must contain visible text');
  const frames = raw.length / (width * height);
  let matched = 0,
    movement = 0;
  for (let f = 0; f < frames; f++) {
    const frame = raw.subarray(f * width * height, (f + 1) * width * height);
    let best = -1,
      offset = 0;
    for (let dy = -range; dy <= range; dy++) {
      if (y + dy + h >= height - 55) continue;
      const pixels = patch(frame, dy);
      let dot = 0,
        sum = 0;
      for (let i = 0; i < pixels.length; i++) {
        dot += pixels[i] * reference[i];
        sum += pixels[i] * pixels[i];
      }
      const score = dot / Math.sqrt(sum) / norm;
      if (score > best) {
        best = score;
        offset = dy;
      }
    }
    if (best > 0.85) {
      matched++;
      movement = Math.max(movement, Math.abs(offset));
    }
  }
  assert(
    frames >= 10 && matched / frames > 0.9,
    `could not track the title: ${matched}/${frames} frames`,
  );
  return { frames, matched, movement };
}

async function recordTap(video, button) {
  const recorder = spawn('xcrun', ['simctl', 'io', sim, 'recordVideo', '--codec=h264', video]);
  const closed = once(recorder, 'close');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('video recorder did not start')), 10_000);
      recorder.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      recorder.stderr.on('data', (data) => {
        if (data.toString().includes('Recording started')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    // Read before tapping so the recording includes the stationary baseline.
    query('elements');
    puppet('tap', { ref: button.ref });
    const dialog = query('elements').elements;
    assert(
      dialog.some((row) => row.verb === 'ConfirmDialog'),
      'tap must open confirmation',
    );
    puppet('screenshot');
  } finally {
    recorder.kill('SIGINT');
    const [code] = await closed;
    assert.equal(code, 0, 'video recorder failed');
  }
}
function swipe(target) {
  const { x, y, w, h } = target.rect;
  puppet('drag', { x: x + w - 36, y: y + h / 2, x2: x + w / 2, y2: y + h / 2 });
  const buttons = query('elements').elements.filter(
    (row) =>
      row.role === 'button' && row.section === 'list' && row.rect.y >= y && row.rect.y < y + h,
  );
  buttons.sort((a, b) => b.rect.x - a.rect.x);
  assert(buttons.length > 0, 'swipe must reveal an action');
  return buttons[0]; // The trailing Delete action; no locale-dependent label match.
}
function snapshot() {
  return fs
    .readdirSync(fixture, { recursive: true })
    .sort()
    .filter((name) => fs.statSync(path.join(fixture, name)).isFile())
    .map((name) => [name, fs.readFileSync(path.join(fixture, name), 'utf8')]);
}
const failures = [];
try {
  puppet('relaunch');
  act('ScrollToRow', { path: marker });
  act('OpenFolder', { path: marker });
  for (const surface of ['note', 'folder', 'search']) {
    if (surface === 'search') {
      act('GoBack');
      act('SetSearchQuery', { query: marker });
    }
    const before = query('elements');
    const candidates = before.elements
      .filter((row) => (surface === 'folder' ? row.folder : row.note))
      .sort((a, b) => a.rect.y - b.rect.y);
    const target = candidates[0];
    assert(target, `${surface}: no target row`);
    const range = Math.ceil(target.rect.h) + 5;
    const anchor = before.elements.find(
      (row) =>
        row.note &&
        row !== target &&
        row.rect.y + 16 - range > before.size.h * 0.6 &&
        row.rect.y + row.rect.h < before.size.h - 55,
    );
    assert(anchor, `${surface}: no unobscured neighboring title to track`);
    const original = snapshot();
    const video = path.join(evidence, `${surface}.mp4`);
    await recordTap(video, swipe(target));
    assert.deepEqual(snapshot(), original, 'opening confirmation must not change files');
    const result = measureMovement(video, before.size, anchor, range);
    fs.writeFileSync(
      path.join(evidence, `${surface}.json`),
      JSON.stringify({ target, anchor, result }, null, 2),
    );
    console.log(`${surface}: ${JSON.stringify(result)}`);
    if (result.movement > 2)
      failures.push(`${surface}: list moved ${result.movement} pt before confirmation`);
    act('DismissDialog');
    assert.deepEqual(snapshot(), original, 'cancel must preserve every file');
    const after = query('elements').elements;
    assert.equal(
      after.find((row) => row.note === anchor.note)?.rect.y,
      anchor.rect.y,
      'cancel must preserve scroll position',
    );
    const sameTarget = after.find((row) =>
      surface === 'folder' ? row.folder === target.folder : row.note === target.note,
    );
    puppet('tap', { ref: swipe(sameTarget).ref });
    act('ConfirmDialog');
    const relative = (target.note ?? target.folder).slice(marker.length + 1);
    assert(
      !fs.existsSync(path.join(fixture, relative + (surface === 'folder' ? '' : '.md'))),
      'confirmed target must disappear',
    );
    if (surface === 'folder')
      assert.equal(
        fs.readFileSync(path.join(fixture, `${relative} child.md`), 'utf8'),
        `${marker}\n`,
        'folder deletion must move its child up',
      );
    const expected =
      surface === 'folder'
        ? original.map(([name, contents]) => [
            name.startsWith(`${relative}/`) ? name.slice(relative.length + 1) : name,
            contents,
          ])
        : original.filter(([name]) => name !== `${relative}.md`);
    assert.deepEqual(
      snapshot(),
      expected.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      'confirmation must only apply the requested mutation',
    );
  }
  act('ClearSearchQuery');
} finally {
  // Retain fixture and evidence for replay. Never remove a vault.
  console.log(`Evidence and isolated fixture retained: ${evidence}, ${fixture}`);
}
assert.deepEqual(failures, [], failures.join('\n'));
console.log('PASS: notes, folders and search stay still until confirmed; cancel preserves files.');

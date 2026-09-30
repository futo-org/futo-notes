#!/usr/bin/env node
// Desktop close must not need the webview's JS thread (RC-37).
//
// A note that is one giant paragraph blocks the renderer's JS thread for a minute
// or more while it opens. The window's close is JS-mediated (startNativeShell.ts
// onCloseRequested), so before the Rust-side deadline (close_deadline.rs) the
// window ignored every close request until the parse finished. Two legs:
//
//   giant  a close request while a giant note is opening: the app exits within
//          the deadline plus a margin, and the giant note's bytes are unchanged.
//   busy, paste, replace
//          a close request on a LIVE page whose JS thread stalls for seconds with an
//          unsaved edit in it (an 8 s task, a 2.5 MB paste, a 2.5 MB replace): the
//          deadline must not cut it, the JS handler saves the edit once the stall
//          ends. Before the dirty-aware deadline these lost the edit.
//   slowdisk
//          every fsync under the vault takes 4 s: the close waits for the write that is
//          still running instead of abandoning it after 3 s (edit kept, no `.sf-tmp-*`).
//   flush  a close request on a responsive page with an unsaved edit: the JS
//          handler still drains the save first, and the app exits well inside the
//          deadline (the deadline is a backstop, not the normal path).
//
// The close request is a real window-manager close (KWin closeWindow, the same
// thing a titlebar X does) — never OS input. Linux only; run under a private
// compositor, e.g. on jfedora:
//
//   dbus-run-session -- bash -c '
//     kwin_wayland --virtual --socket wl-close --width 1600 --height 1000 & sleep 3
//     WAYLAND_DISPLAY=wl-close GDK_BACKEND=wayland node tests/desktop-close-deadline.mjs'
//
// `--close-cmd` overrides the default KWin helper for another window manager.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startDesktopTauriInstance } from './lib/tauri-instance.mjs';
import { executeJs, sleep } from './lib/mcp-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    lines: { type: 'string', default: '100000' },
    'close-cmd': {
      type: 'string',
      default: `sh ${path.join(root, 'tests/lib/kwin-close-windows.sh')}`,
    },
    'close-at-s': { type: 'string', default: '8' },
    // Keep in step with CLOSE_DEADLINE in apps/tauri/src-tauri/src/close_deadline.rs.
    'deadline-s': { type: 'string', default: '5' },
    'margin-s': { type: 'string', default: '6' },
    // How long to keep watching for an exit that never comes. The default fails
    // fast; raise it to MEASURE an unfixed build (RC-37 was ~107 s).
    'exit-wait-s': { type: 'string' },
    leg: { type: 'string', default: 'all' },
    out: { type: 'string' },
  },
});
const deadlineMs = Number(args['deadline-s']) * 1000;
const exitWaitMs =
  Number(args['exit-wait-s'] ?? Number(args['deadline-s']) + Number(args['margin-s'])) * 1000;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const report = { legs: {} };

function storageWith(files) {
  const parent = process.env.FUTO_VERIFICATION_DIR || path.join(root, '.tauri-data');
  fs.mkdirSync(parent, { recursive: true });
  const instanceDir = fs.mkdtempSync(path.join(parent, 'close-deadline-'));
  const dataDir = path.join(instanceDir, 'data');
  const notesDir = path.join(instanceDir, 'notes');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'notes-dir-override.json'), JSON.stringify({ notesDir }));
  for (const [name, body] of Object.entries(files))
    fs.writeFileSync(path.join(notesDir, name), body);
  return { instanceDir, dataDir, notesDir };
}

// 100,000 single-newline-joined lines (~5 MB): one paragraph, no block marker, no chunk
// boundary. On a quiet jfedora this blocks the JS thread ~82 s (50,000 lines: ~11.6 s; the
// cost is super-linear), so the close request lands well inside the wedge on any box.
function giantParagraph(lines) {
  const rows = [];
  for (let i = 0; i < lines; i += 1) rows.push(`w${i} lorem ipsum dolor sit amet consectetur adip`);
  return rows.join('\n') + '\n';
}

function requestWindowClose() {
  execSync(args['close-cmd'], { encoding: 'utf8', timeout: 20_000, stdio: 'pipe' });
}

function exited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/** Milliseconds from now until the process exits, or null if it outlives `limitMs`. */
async function exitAfter(proc, limitMs, probe = null) {
  const t0 = Date.now();
  let lastProbe = 0;
  while (Date.now() - t0 < limitMs) {
    if (exited(proc)) return Date.now() - t0;
    if (probe && Date.now() - lastProbe >= 500) {
      lastProbe = Date.now();
      await probe(Date.now() - t0);
    }
    await sleep(100);
  }
  return exited(proc) ? Date.now() - t0 : null;
}

async function launch(files, env = {}) {
  const storage = storageWith(files);
  return startDesktopTauriInstance('close-deadline', root, { storage, env });
}

function killIfAlive(client) {
  try {
    if (client?.proc && !exited(client.proc)) client.proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

async function giantLeg() {
  const body = giantParagraph(Number(args.lines));
  const before = { bytes: Buffer.byteLength(body), sha: sha(Buffer.from(body)) };
  const client = await launch({ 'Giant.md': body, 'Other.md': 'Other note.\n' });
  try {
    await sleep(1500);
    // Fire and forget: the parse blocks the JS thread, so this never answers.
    executeJs(client.ws, `location.hash = '#/note/Giant'; 'set'`, { timeoutMs: 5000 }).catch(
      () => {},
    );
    // Precondition: the renderer is wedged and STAYS wedged until the close request.
    // The first seconds after the hash change are not a hard block (a close then can
    // still get through), so the request waits for --close-at-s of continuous silence.
    const setAt = Date.now();
    let firstFailAt = null;
    while (Date.now() - setAt < Number(args['close-at-s']) * 1000) {
      await sleep(500);
      try {
        await executeJs(client.ws, '1', { timeoutMs: 400 });
        assert.equal(
          firstFailAt,
          null,
          `the JS thread answered at ${Date.now() - setAt} ms after going silent at ${firstFailAt} ms; the wedge ended early, raise --lines (${args.lines})`,
        );
      } catch (error) {
        if (error.name === 'AssertionError') throw error;
        firstFailAt ??= Date.now() - setAt;
      }
    }
    assert.notEqual(
      firstFailAt,
      null,
      `the giant note never wedged the JS thread; raise --lines (${args.lines})`,
    );
    let blockedAtClose = false;
    try {
      await executeJs(client.ws, '1', { timeoutMs: 1000 });
    } catch {
      blockedAtClose = true;
    }
    const closeAt = Date.now();
    requestWindowClose();
    // Did the JS thread come back before the exit? If it did, the exit went through
    // the JS handler and proves nothing about the deadline.
    let jsAnsweredAtMs = null;
    const exitMs = await exitAfter(client.proc, exitWaitMs, async (at) => {
      if (jsAnsweredAtMs !== null) return;
      try {
        await executeJs(client.ws, '1', { timeoutMs: 300 });
        jsAnsweredAtMs = at;
      } catch {
        /* still blocked, or already gone */
      }
    });
    const file = fs.readFileSync(path.join(client.notesDir, 'Giant.md'));
    const leg = {
      lines: Number(args.lines),
      chars: before.bytes,
      exitMs,
      closeToReturnMs: Date.now() - closeAt,
      blockedAtClose,
      jsAnsweredAtMs,
      exitCode: client.proc.exitCode,
      signal: client.proc.signalCode,
      bytesUnchanged: file.length === before.bytes && sha(file) === before.sha,
    };
    report.legs.giant = leg;
    console.log(`giant: ${JSON.stringify(leg)}`);
    assert.notEqual(
      exitMs,
      null,
      `the app did not exit within ${exitWaitMs} ms of a close request`,
    );
    assert.ok(
      exitMs <= deadlineMs + Number(args['margin-s']) * 1000,
      `exit took ${exitMs} ms; deadline ${deadlineMs} ms + ${args['margin-s']} s margin`,
    );
    assert.ok(
      exitMs >= 1000,
      'the exit was not the deadline path (too fast for a wedged renderer)',
    );
    assert.equal(leg.bytesUnchanged, true, 'Giant.md bytes changed across the close');
  } finally {
    killIfAlive(client);
  }
}

async function flushLeg() {
  const client = await launch({ 'Plain.md': 'Before.\n' });
  try {
    await client.openNote('Plain');
    const typed = 'Typed just before the window closed.';
    await executeJs(
      client.ws,
      `window.__notesShellTest.replaceEditorContent(${JSON.stringify(typed)})`,
    );
    const file = path.join(client.notesDir, 'Plain.md');
    requestWindowClose();
    const exitMs = await exitAfter(client.proc, exitWaitMs);
    const onDisk = fs.readFileSync(file, 'utf8');
    const leg = {
      exitMs,
      onDisk: onDisk === typed || onDisk === `${typed}\n` ? 'typed text' : 'STALE',
    };
    report.legs.flush = leg;
    console.log(`flush: ${JSON.stringify(leg)}`);
    assert.notEqual(exitMs, null, 'the app did not exit after a close request on a live page');
    assert.ok(
      exitMs < deadlineMs,
      `a live page must exit through the JS handler, not the deadline (${exitMs} ms)`,
    );
    assert.equal(leg.onDisk, 'typed text', 'the JS close handler did not drain the pending save');
  } finally {
    killIfAlive(client);
  }
}

// A live page whose JS thread stalls with an unsaved edit in it: the deadline must
// not cut it (R10 FB-9). The edit is typed through the test hook (which announces it
// the way a keystroke's `beforeinput` does), then the page stalls, then the window is
// asked to close 300 ms later. The JS handler can only run once the stall ends, so a
// correct exit happens AFTER the deadline, with the edit on disk.
const STALLS = {
  // A long task that is not a note open.
  busy: {
    arm: (marker) => `window.__notesShellTest.typeInEditor(${JSON.stringify(marker)});
      setTimeout(() => { const t = Date.now(); while (Date.now() - t < 8000); }, 0); 'armed'`,
    saved: (onDisk, marker) => onDisk.includes(marker),
  },
  // A multi-megabyte paste parsing synchronously (WebKitGTK: ~10 s at 2.5 MB).
  paste: {
    arm: () => `(() => {
      const text = ${JSON.stringify(giantParagraph(50_000))};
      const data = new DataTransfer();
      data.setData('text/plain', text);
      document.querySelector('.ProseMirror').focus();
      document.querySelector('.ProseMirror').dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      return 'pasted'; })()`,
    saved: (onDisk) => onDisk.length > 2_000_000,
  },
  // The whole document swapped for 2.5 MB through the test hook.
  replace: {
    arm: () =>
      `window.__notesShellTest.replaceEditorContent(${JSON.stringify(giantParagraph(50_000))}); 'replaced'`,
    saved: (onDisk) => onDisk.length > 2_000_000,
  },
};

async function stallLeg(name) {
  const stall = STALLS[name];
  const client = await launch({ 'Plain.md': 'Before.\n' });
  try {
    await client.openNote('Plain');
    const marker = `Typed-before-the-stall-${Date.now()}`;
    // Fire and forget: the script blocks the JS thread, so it never answers in time.
    executeJs(client.ws, stall.arm(marker), { timeoutMs: 2000 }).catch(() => {});
    await sleep(300);
    requestWindowClose();
    const exitMs = await exitAfter(client.proc, 120_000);
    const onDisk = fs.readFileSync(path.join(client.notesDir, 'Plain.md'), 'utf8');
    const leg = { exitMs, bytesOnDisk: onDisk.length, edited: stall.saved(onDisk, marker) };
    report.legs[name] = leg;
    console.log(`${name}: ${JSON.stringify(leg)}`);
    assert.notEqual(exitMs, null, `${name}: the app never exited`);
    assert.ok(
      exitMs > deadlineMs + 500,
      `${name}: exit at ${exitMs} ms: too early, the stall had not ended, so the edit cannot have been saved`,
    );
    assert.equal(leg.edited, true, `${name}: the edit typed before the stall was lost`);
  } finally {
    killIfAlive(client);
  }
}

// A slow disk: every fsync under the vault takes 4 s (an LD_PRELOAD shim compiled on
// the spot). The JS handler used to give up on its save after 3 s and exit mid-write,
// losing the edit and leaving a hidden `.sf-tmp-*` beside the old file. It now waits
// for a write that is still running.
function compileSlowFsyncShim() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-fsync-'));
  const source = path.join(dir, 'slowfsync.c');
  fs.writeFileSync(
    source,
    `#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int fsync(int fd) {
  static int (*real)(int);
  if (!real) real = dlsym(RTLD_NEXT, "fsync");
  char link[64], target[1024];
  snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(link, target, sizeof target - 1);
  const char *match = getenv("SLOWFS_MATCH");
  if (n > 0 && match) { target[n] = 0; if (strstr(target, match)) usleep(atoi(getenv("SLOWFS_MS")) * 1000); }
  return real(fd);
}
`,
  );
  const library = path.join(dir, 'slowfsync.so');
  execSync(`cc -shared -fPIC -o ${library} ${source} -ldl`, { stdio: 'pipe' });
  return library;
}

async function slowdiskLeg() {
  const shim = compileSlowFsyncShim();
  const client = await launch(
    { 'Plain.md': 'Before.\n' },
    { LD_PRELOAD: shim, SLOWFS_MATCH: '/notes/', SLOWFS_MS: '4000' },
  );
  try {
    await client.openNote('Plain');
    const marker = `Typed-on-a-slow-disk-${Date.now()}`;
    await executeJs(client.ws, `window.__notesShellTest.typeInEditor(${JSON.stringify(marker)})`);
    requestWindowClose();
    const exitMs = await exitAfter(client.proc, 60_000);
    const onDisk = fs.readFileSync(path.join(client.notesDir, 'Plain.md'), 'utf8');
    const leftovers = fs.readdirSync(client.notesDir).filter((name) => name.includes('.sf-tmp-'));
    const leg = { exitMs, edited: onDisk.includes(marker), leftovers };
    report.legs.slowdisk = leg;
    console.log(`slowdisk: ${JSON.stringify(leg)}`);
    assert.notEqual(exitMs, null, 'slowdisk: the app never exited');
    assert.equal(leg.edited, true, 'slowdisk: the edit was lost to a write the exit abandoned');
    assert.deepEqual(leftovers, [], 'slowdisk: a hidden temp file was left in the vault');
  } finally {
    killIfAlive(client);
  }
}

try {
  if (args.leg === 'all' || args.leg === 'flush') await flushLeg();
  if (args.leg === 'all' || args.leg === 'slowdisk') await slowdiskLeg();
  for (const name of Object.keys(STALLS))
    if (args.leg === 'all' || args.leg === name) await stallLeg(name);
  if (args.leg === 'all' || args.leg === 'giant') await giantLeg();
  console.log('desktop close deadline: PASS');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
}

#!/usr/bin/env node
// macOS: a quit right after typing must not lose the edit (RC-85).
//
// AppKit's terminate: (Cmd-Q, Dock Quit, AppleScript quit, logout) used to go
// straight to tao's applicationWillTerminate:, which raises neither CloseRequested
// nor ExitRequested, so the page's close handler (the save flush) never ran and an
// edit typed in the last ~0.5 s before the quit was lost (19 of 20 runs).
//
// Drives a debug .app built under its OWN bundle identifier, with its own data
// dir and a temp vault, never an installed app and never a real vault:
//
//   VITE_INCLUDE_TEST_HOOKS=true cargo tauri build --debug --bundles app \
//     --config '{"identifier":"com.futo.notes.myquitcheck"}'     (run in apps/tauri)
//   node tests/macos-quit-flush.mjs --app ".../FUTO Notes.app" --via apple-event --gaps 50,300
//
// --via apple-event  osascript `tell application id "<that id>" to quit`: the
//                    real AppleEvent a Dock Quit sends, landing on terminate:.
// --via menu         the app menu's Quit item action, through a debug-only
//                    command that runs the very handler the menu item runs (the
//                    accelerator itself would need OS keystrokes, which QA never sends).
//
// The bundle id is read from the app's Info.plist. Nothing here resolves an
// application through Launch Services (`path to application id` launched the
// installed dev app once and hung against the prod one); the one AppleEvent names
// an id this script refuses to accept unless it is neither of the shipped ones.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { discoverPort, connectWs, executeJs, sleep } from './lib/mcp-client.mjs';
import { TauriTestClient, waitForTestHooks } from './lib/tauri-test-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    app: { type: 'string' },
    via: { type: 'string', default: 'apple-event' },
    // gap: quit N ms after typing. stall: type, then an 8 s JS stall, quit 300 ms later.
    // giant: quit during a giant-note open (the close deadline must end it).
    scenario: { type: 'string', default: 'gap' },
    lines: { type: 'string', default: '100000' },
    gaps: { type: 'string', default: '50,300' },
    tries: { type: 'string', default: '10' },
    port: { type: 'string', default: '9461' },
    out: { type: 'string' },
  },
});
if (process.platform !== 'darwin') throw new Error('macOS only');
if (!args.app) throw new Error('--app "<path to a debug .app with its own bundle id>" is required');
if (!['apple-event', 'menu'].includes(args.via)) throw new Error('--via apple-event | menu');
if (!['gap', 'stall', 'giant'].includes(args.scenario))
  throw new Error('--scenario gap | stall | giant');

const plist = (key) =>
  execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', `Print ${key}`, path.join(args.app, 'Contents/Info.plist')],
    {
      encoding: 'utf8',
    },
  ).trim();
const bundleId = plist('CFBundleIdentifier');
const executable = path.join(args.app, 'Contents/MacOS', plist('CFBundleExecutable'));

// Every identifier the repo ships (prod, dev, updater test configs, ...).
const shipped = new Set();
const confDir = path.join(root, 'apps/tauri/src-tauri');
for (const name of fs.readdirSync(confDir))
  if (/^tauri.*\.conf\.json$/.test(name)) {
    const id = JSON.parse(fs.readFileSync(path.join(confDir, name), 'utf8')).identifier;
    if (id) shipped.add(id);
  }
if (shipped.has(bundleId) || !/^com\.futo\.notes\.[a-z0-9]+$/.test(bundleId))
  throw new Error(
    `refusing ${bundleId}: build the app under its own unique identifier (com.futo.notes.<unique>), not a shipped one (${[...shipped].join(', ')})`,
  );

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-quit-flush-'));
const results = [];

async function oneTry(gapMs, n) {
  const dataDir = path.join(tmpRoot, `data-${gapMs}-${n}`);
  const notesDir = path.join(tmpRoot, `vault-${gapMs}-${n}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'notes-dir-override.json'), JSON.stringify({ notesDir }));
  fs.writeFileSync(path.join(notesDir, 'Plain.md'), 'Before.\n');
  let giantBody = null;
  if (args.scenario === 'giant') {
    giantBody =
      Array.from(
        { length: Number(args.lines) },
        (_, i) => `w${i} lorem ipsum dolor sit amet consectetur adip`,
      ).join('\n') + '\n';
    fs.writeFileSync(path.join(notesDir, 'Giant.md'), giantBody);
  }
  const logFile = path.join(tmpRoot, `app-${gapMs}-${n}.log`);
  const logFd = fs.openSync(logFile, 'w');
  const proc = spawn(executable, [], {
    env: {
      ...process.env,
      FUTO_NOTES_DATA_DIR: dataDir,
      FUTO_NOTES_MULTI_INSTANCE: '1',
      FUTO_MCP_BASE_PORT: args.port,
    },
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  let exited = false;
  proc.once('exit', () => (exited = true));
  try {
    const port = await discoverPort(logFile, 90_000);
    const ws = await connectWs(port);
    await waitForTestHooks(ws, 'quit-flush', {
      initialDelayMs: 0,
      attempts: 45,
      intervalMs: 2_000,
    });
    const client = new TauriTestClient({
      name: 'quit-flush',
      platform: 'desktop',
      proc,
      ws,
      port,
      notesDir,
      dataDir,
      logFile,
    });
    const requestQuit = () => {
      if (args.via === 'menu') {
        // Fire and forget: the app may be gone before the reply.
        executeJs(
          ws,
          `window.__TAURI_INTERNALS__.invoke('app_menu_dispatch_for_test', { id: 'quit' }); 'sent'`,
          { timeoutMs: 3000 },
        ).catch(() => {});
      } else {
        // The AppleEvent reply arrives only once the app has answered the terminate, so it is
        // never awaited: the exit, read off the process, is the measurement.
        spawn('/usr/bin/osascript', ['-e', `tell application id "${bundleId}" to quit`], {
          stdio: 'ignore',
        });
      }
    };
    const waitForExit = async (limitMs) => {
      for (let i = 0; i < limitMs / 100 && !exited; i += 1) await sleep(100);
    };
    if (args.scenario === 'giant') {
      // Wedge the page with the giant open, stay silent for 8 s, then quit: nothing is
      // unsaved, so the close deadline (5 s) must end it without the JS thread.
      executeJs(ws, `location.hash = '#/note/Giant'; 'set'`, { timeoutMs: 5000 }).catch(() => {});
      const setAt = Date.now();
      let firstFail = null;
      while (Date.now() - setAt < 8000) {
        await sleep(500);
        try {
          await executeJs(ws, '1', { timeoutMs: 400 });
          if (firstFail !== null) throw new Error('the wedge ended early; raise --lines');
        } catch (error) {
          if (String(error.message).includes('wedge ended')) throw error;
          firstFail ??= Date.now() - setAt;
        }
      }
      if (firstFail === null)
        throw new Error('the giant note never wedged the page; raise --lines');
      const quitAt = Date.now();
      requestQuit();
      await waitForExit(60_000);
      const file = fs.readFileSync(path.join(notesDir, 'Giant.md'), 'utf8');
      return {
        gapMs: 'giant',
        exitMs: exited ? Date.now() - quitAt : null,
        lost: file !== giantBody,
        exited,
      };
    }
    await client.openNote('Plain');
    const marker = `Typed-${gapMs}-${n}-${Date.now()}`;
    if (args.scenario === 'stall') {
      // Fire and forget: the stall blocks the thread. typeInEditor announces the edit first.
      executeJs(
        ws,
        `window.__notesShellTest.typeInEditor(${JSON.stringify(marker)});
         setTimeout(() => { const t = Date.now(); while (Date.now() - t < 8000); }, 0); 'armed'`,
        { timeoutMs: 2000 },
      ).catch(() => {});
      await sleep(300);
      const quitAt = Date.now();
      requestQuit();
      await waitForExit(60_000);
      const onDisk = fs.readFileSync(path.join(notesDir, 'Plain.md'), 'utf8');
      return {
        gapMs: 'stall',
        exitMs: exited ? Date.now() - quitAt : null,
        lost: !onDisk.includes(marker),
        exited,
      };
    }
    await client.typeInEditor(marker);
    const typedAt = Date.now();
    await sleep(Math.max(0, gapMs - (Date.now() - typedAt)));
    const quitAt = Date.now();
    requestQuit();
    await waitForExit(20_000);
    const exitMs = exited ? Date.now() - typedAt : null;
    const onDisk = fs.readFileSync(path.join(notesDir, 'Plain.md'), 'utf8');
    return { gapMs, exitMs, quitCallMs: quitAt - typedAt, lost: !onDisk.includes(marker), exited };
  } finally {
    if (!exited) proc.kill('SIGKILL');
  }
}

const gaps = args.scenario === 'gap' ? args.gaps.split(',').map(Number) : [args.scenario];
for (const gap of gaps) {
  let lost = 0;
  for (let n = 0; n < Number(args.tries); n += 1) {
    const r = await oneTry(gap, n);
    results.push(r);
    if (r.lost) lost += 1;
    console.log(JSON.stringify(r));
  }
  console.log(
    `via ${args.via}, ${args.scenario === 'gap' ? `gap ${gap} ms` : gap}: ${lost}/${args.tries} lost`,
  );
}
if (args.out)
  fs.writeFileSync(args.out, JSON.stringify({ bundleId, via: args.via, results }, null, 2));
fs.rmSync(tmpRoot, { recursive: true, force: true });
const anyLost = results.some((r) => r.lost || !r.exited);
process.exitCode = anyLost ? 1 : 0;

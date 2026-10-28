// Put the running app back on the fixture vault, at home, no tabs, no overlays.
// FUTO_PUPPET_TARGET picks the app: the desktop dev build (default), the iOS simulator
// this worktree claimed ($SIM) or its Android emulator ($ANDROID_SERIAL, app storage).
// A phone's store does NOT watch its vault — it reads it at launch — so a phone reset
// writes the fixture and relaunches the app, where desktop just writes. Android's vault
// is on the device, so the verifier reads a local copy `pullVault()` takes.
//
// FUTO_HARNESS_MAIN_TREE=<checkout of main> is the main arm: main's desktop app, which has no
// `just puppet`. Its reset relaunches that checkout's app on a fresh data dir holding the
// fixture, and its verifiers read the vault only, so tasks that check `state` are left out.
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const defaultFixture = join(here, 'fixture');
export const target = process.env.FUTO_PUPPET_TARGET ?? 'desktop';
export const mainTree = process.env.FUTO_HARNESS_MAIN_TREE ?? null;
if (mainTree && target !== 'desktop') throw new Error('the main arm is desktop only');
const BUNDLE = 'com.futo.notes.dev';
const sim = () => process.env.SIM ?? 'booted';
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8' }).trim();
// App storage (the first-run picker's `app`): the one location `adb` can write without a grant.
const DEVICE_VAULT = `/storage/emulated/0/Android/data/${BUNDLE}/files/futo-notes`;
const adb = (...args) => run('adb', args);
export const vault =
  target === 'ios'
    ? join(
        run('xcrun', ['simctl', 'get_app_container', sim(), BUNDLE, 'data']),
        'Documents/fake-notes',
      )
    : target === 'android'
      ? join(here, 'work/android-vault')
      : join(mainTree ?? repo, '.tauri-data/notes');

/** Android only: replace the local copy with the device's vault, for the verifier. */
export function pullVault() {
  if (target !== 'android') return;
  rmSync(vault, { recursive: true, force: true });
  mkdirSync(dirname(vault), { recursive: true });
  adb('pull', DEVICE_VAULT, vault);
}

// What the verifier sees: the vault after saves have settled, and `state`.
export const oracle = () => {
  sleep(1.5);
  pullVault();
  const notePath = (id) => join(vault, `${id}.md`);
  return {
    vault: {
      folderExists: (path) =>
        existsSync(join(vault, path)) && statSync(join(vault, path)).isDirectory(),
    },
    read: (id) => (existsSync(notePath(id)) ? readFileSync(notePath(id), 'utf8') : ''),
    exists: (id) => existsSync(notePath(id)),
    list: () => readdirSync(vault, { recursive: true }).filter((entry) => entry.endsWith('.md')),
    state: mainTree ? {} : phoneNote(JSON.parse(agent('state', '{"json":true}') || '{}')),
  };
};

// A phone's `state` names the open note in its screen (`editor:<id>`), the desktop's in `note`;
// the verifiers read the desktop's.
const phoneNote = (state) =>
  state.note || !state.screen?.startsWith('editor:')
    ? state
    : { ...state, note: { id: state.screen.slice('editor:'.length) } };

export function agent(...args) {
  try {
    return execFileSync(join(repo, 'target/debug/futo-puppet'), args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (error) {
    return error.stdout ?? '';
  }
}
const json = (...args) => JSON.parse(agent(...args) || 'null');
const quietly = (verb, args) => agent('do', verb, ...(args ? [JSON.stringify(args)] : []));
const sleep = (seconds) => execFileSync('sleep', [String(seconds)]);

// A set with its own vault (heldout/) passes its fixture directory to `reset`.
let fixture = defaultFixture;
function seedVault() {
  for (const entry of readdirSync(vault))
    rmSync(join(vault, entry), { recursive: true, force: true });
  cpSync(fixture, vault, { recursive: true });
}

// The fixture as the store reports it: every folder and every note, and nothing from the
// previous task. `notes` is the vault's own answer, which the desktop tree (collapsed
// folders) and the phone's list (native, outside the page) both fail to give.
function fixtureContents() {
  const entries = readdirSync(fixture, { recursive: true, withFileTypes: true });
  const relative = (entry) => join(entry.parentPath, entry.name).slice(fixture.length + 1);
  return {
    notes: entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => relative(entry).slice(0, -3))
      .sort(),
    folders: entries.filter((entry) => entry.isDirectory()).map(relative),
  };
}
function settled(expected) {
  const vaultNow = json('notes', '{"json":true}');
  if (!vaultNow) return false;
  const notes = [...(vaultNow.notes ?? [])].sort();
  return (
    notes.length === expected.notes.length &&
    notes.every((id, index) => id === expected.notes[index]) &&
    expected.folders.every((folder) => (vaultNow.folders ?? []).includes(folder))
  );
}

function waitForFixture() {
  const expected = fixtureContents();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (settled(expected)) return json('state', '{"json":true}');
    sleep(0.5);
  }
  throw new Error(
    `vault did not settle on the fixture: ${agent('notes', '{"json":true}').slice(0, 2000)}`,
  );
}

function resetAndroid() {
  // A fresh install's state, then the fixture, then the first-run picker taken through its
  // verbs. The order is the point: files the APP creates are closed to adb's shell user, so
  // the vault is replaced only while the app has not touched it yet.
  adb('shell', 'pm', 'clear', BUNDLE);
  adb('shell', 'mkdir', '-p', DEVICE_VAULT);
  adb('push', `${fixture}/.`, DEVICE_VAULT);
  adb('shell', 'am', 'start', '-n', `${BUNDLE}/com.futo.notes.MainActivity`);
  const deadline = Date.now() + 30_000;
  while (json('state')?.screen !== 'onboarding') {
    if (Date.now() > deadline) throw new Error(`no first-run picker: ${agent('state')}`);
    sleep(0.3);
  }
  quietly('SelectStorageMode', { mode: 'app' });
  quietly('ContinueStorage');
  return waitForFixture();
}

function resetPhone() {
  seedVault();
  // No file watcher on the phone: the store reads the vault when the app starts.
  // An app that crashed in the last task has nothing to terminate; that task already failed.
  try {
    execFileSync('xcrun', ['simctl', 'terminate', sim(), BUNDLE], { stdio: 'ignore' });
  } catch {
    /* not running */
  }
  // The screen reader needs the simulator's accessibility on, and the app reads it at launch
  // (apps/ios/run.sh sets it the same way). It was found off mid-run (2026-10-05).
  run('xcrun', [
    'simctl',
    'spawn',
    sim(),
    'defaults',
    'write',
    'com.apple.Accessibility',
    'ApplicationAccessibilityEnabled',
    '-bool',
    'true',
  ]);
  const port = JSON.parse(run('node', [join(repo, 'scripts/lib/slot.mjs')])).ports.puppet;
  execFileSync('xcrun', ['simctl', 'launch', sim(), BUNDLE], {
    env: { ...process.env, SIMCTL_CHILD_FUTO_PUPPET_PORT: String(port) },
    encoding: 'utf8',
  });
  return waitForFixture();
}

export function reset(fixtureDir = defaultFixture) {
  fixture = fixtureDir;
  if (mainTree) return resetMain();
  agent('clipboard', '{"clear":true}');
  if (target === 'ios') return resetPhone();
  if (target === 'android') return resetAndroid();
  quietly('DismissDialog');
  quietly('CloseSettings');
  quietly('CloseSearch');
  quietly('GoHome');
  for (let i = 0; i < 20 && (json('state')?.tabs?.length ?? 0) > 0; i++) quietly('CloseActiveTab');
  const state = json('state');
  if (state?.sidebar?.collapsed) quietly('ToggleSidebar');
  if (state?.sidebar?.view !== 'notes') quietly('SetSidebarView', { view: 'notes' });
  seedVault();
  const settledState = waitForFixture();
  if (fixture !== defaultFixture) collapseFolders();
  waitForSearch();
  return settledState;
}

// Rewriting every file reindexes the whole vault, and a search waits for that: the first one
// after a reset outlasted the bridge's 5 s script timeout. No user swaps a vault between
// requests, so the reset waits until search answers.
function waitForSearch() {
  const deadline = Date.now() + 60_000;
  while (!agent('search', '{"query":"the"}').includes('hits')) {
    if (Date.now() > deadline) throw new Error('search did not answer within 60 s of the reset');
    sleep(0.5);
  }
}

// Folder expansion persists across resets, so a set with a large vault starts every task with
// every folder closed: which rows the sidebar draws is then the same for every run. A folder is
// open when a row inside it is drawn; the deepest go first, so a reopened parent stays tidy.
function collapseFolders() {
  for (let pass = 0; pass < 10; pass++) {
    const rows = (json('elements', '{"json":true}')?.elements ?? []).filter((element) =>
      element.component?.startsWith('FolderTree'),
    );
    const ids = rows.map((row) => row.note ?? row.folder).filter(Boolean);
    const open = rows
      .filter((row) => row.folder && ids.some((id) => id.startsWith(`${row.folder}/`)))
      .map((row) => row.folder);
    if (!open.length) return;
    for (const folder of open.sort((a, b) => b.split('/').length - a.split('/').length))
      quietly('ToggleFolder', { path: folder });
  }
  throw new Error('folders did not collapse');
}

// The main arm's reset: stop the app this harness started, and anything else of that checkout's
// (an agent may have launched its own), then relaunch it on a fresh data dir holding the fixture.
// It writes the log and PID file where main's /verify looks, so the agent finds it running.
async function resetMain() {
  const { slot } = JSON.parse(run('node', [join(mainTree, 'scripts/lib/slot.mjs')]));
  const log = `/tmp/tauri-verify-${slot}.log`;
  const pidFile = `/tmp/tauri-verify-${slot}.pid`;
  if (existsSync(pidFile)) await stopGroup(Number(readFileSync(pidFile, 'utf8')));
  try {
    execFileSync('node', ['scripts/qa-target.mjs', 'kill'], { cwd: mainTree, stdio: 'ignore' });
  } catch {
    /* nothing of this checkout's was running */
  }
  rmSync(join(mainTree, '.tauri-data'), { recursive: true, force: true });
  mkdirSync(vault, { recursive: true });
  cpSync(fixture, vault, { recursive: true });
  const out = openSync(log, 'w');
  const app = spawn('just', ['tauri-dev'], {
    cwd: mainTree,
    detached: true,
    stdio: ['ignore', out, out],
  });
  app.unref();
  writeFileSync(pidFile, String(app.pid));
  const port = await bridgePort(log);
  // Sidebar, folder and sort state live in the web view's localStorage, which outlives the data
  // dir: clear it and reload, so every task starts at home with every folder closed.
  await untilReady(port);
  await bridge(port, 'localStorage.clear(); setTimeout(() => location.reload(), 0); true');
  await pause(2);
  await untilReady(port);
  return { port };
}

const pause = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function stopGroup(pid) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 60; i++) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    await pause(0.5);
  }
  process.kill(-pid, 'SIGKILL');
}

async function bridgePort(log) {
  // The first launch of a checkout compiles the app.
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const port = readFileSync(log, 'utf8')
      .match(/initialized for .* on [^:\s]*:(\d+)/g)
      ?.at(-1);
    if (port) return Number(port.split(':').at(-1));
    await pause(1);
  }
  throw new Error(`main app never printed its bridge port: ${log}`);
}

// Ready as the desktop reset means it: the store holds the fixture and search answers.
async function untilReady(port) {
  const expected = fixtureContents().notes.length;
  const deadline = Date.now() + 120_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await bridge(
        port,
        `(async () => ({ notes: window.__testNotes?.getAllNotes().length ?? 0, hits: window.__testSearch ? (await window.__testSearch.search('the')).length : 0 }))()`,
      );
      if (last?.notes === expected && last.hits > 0) return;
    } catch (error) {
      last = error.message;
    }
    await pause(0.5);
  }
  throw new Error(`main app not ready: ${JSON.stringify(last)}`);
}

// One `execute_js` over the debug bridge's WebSocket (main's references/desktop.md).
function bridge(port, script) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('bridge timed out'));
    }, 10_000);
    socket.onopen = () =>
      socket.send(JSON.stringify({ id: 'r1', command: 'execute_js', args: { script } }));
    socket.onmessage = (message) => {
      clearTimeout(timer);
      socket.close();
      const reply = JSON.parse(message.data);
      if (!reply.success) return reject(new Error(JSON.stringify(reply).slice(0, 300)));
      resolve(typeof reply.data === 'string' ? JSON.parse(reply.data) : reply.data);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('bridge unreachable'));
    };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await reset(), null, 2));

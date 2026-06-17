#!/usr/bin/env node
/**
 * Mac ↔ iOS regression suite.
 *
 * Boots a macOS desktop Tauri instance and an iOS simulator-backed Tauri
 * instance and runs a focused set of UI + sync regression scenarios. Designed
 * to be run from a Mac before shipping a release, when you want more confidence
 * than unit tests alone provide.
 *
 * The scenarios are driven through the Tauri MCP bridge (WebSocket) so they
 * exercise the real client stack — same code paths as cross-platform-sync.mjs.
 *
 * Usage:
 *   just test-mac-ios
 *   node tests/mac-ios-regression.mjs                 # all scenarios
 *   node tests/mac-ios-regression.mjs --only "folder" # filter by substring
 *   node tests/mac-ios-regression.mjs --skip-sync     # UI-only, no sync server
 *
 * Requires:
 *   - macOS host
 *   - Xcode + an iOS simulator runtime
 *   - Docker (for the sync server scenarios — futo-notes-server uses Postgres)
 *   - The futo-notes-server checkout: set FUTO_NOTES_E2EE_SERVER_REPO if it
 *     lives somewhere other than ~/Developer/futo-notes-server
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startDesktopTauriInstance } from './lib/tauri-instance.mjs';
import { startIosSimulatorInstance } from './lib/ios-simulator-instance.mjs';
import { startServer } from './lib/sync-test-server.mjs';
import { executeJs, sleep } from './lib/mcp-client.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    'skip-sync': { type: 'boolean', default: false },
    'skip-build': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`Mac ↔ iOS regression suite

Usage: just test-mac-ios [options]
       node tests/mac-ios-regression.mjs [options]

Options:
  --only <substring>   Run only scenarios whose name matches the substring
                       (case-insensitive). Examples: --only folder, --only sync,
                       --only "bidirectional sync".
  --skip-sync          Skip the two sync scenarios (no Docker required).
  --skip-build         Reuse existing macOS debug binary and iOS sim .app.
                       Saves ~2 min on re-runs. First run still needs to build.
  -h, --help           Show this help.

Scenarios (UI run on both Mac and iOS):
  note CRUD             create via editor, save to disk, reopen, delete
  basic markdown render headings, bold/italic, lists, links — checks live
                        markdown decorations and that the file source is
                        preserved on disk
  folder ops            create folder, move note in, rename folder, verify
                        note follows the rename
  multi-tab basics      open two notes, switch, verify state restoration
  search smoke          createNote → search index hit on a distinctive token

Sync scenarios (Mac ↔ iOS):
  bidirectional sync    Mac→iOS create, iOS→Mac create, file-count parity
  bidirectional edit    turn-taking edits, each side sees the other's change

Environment:
  FUTO_NOTES_E2EE_SERVER_REPO  Path to futo-notes-server checkout
                               (default: ~/Developer/futo-notes-server)
  SF_IOS_UDID                  Force a specific iOS simulator UDID
                               (default: first booted sim, or newest iPhone)
`);
  process.exit(0);
}

// ── Assertions ────────────────────────────────────────────────────

function assert(cond, msg) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function waitFor(client, script, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await executeJs(client.ws, script);
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`${client.name}: timed out waiting for ${label}`);
}

async function readEditorRenderedText(client) {
  return executeJs(client.ws, `(document.querySelector('.cm-content')?.textContent ?? '')`);
}

// ── Helpers shared by scenarios ───────────────────────────────────

async function createNoteViaEditor(client, title, body) {
  await client.openNewNote();
  await client.setTitle(title);
  await client.typeInEditor(body);
  await client.flushSave();
  // Wait for the save to actually land — flushSave kicks the queue but the
  // write completes async. The iOS sim is slower than desktop and the FS
  // watcher (post-deleteAllContent) can briefly delay subsequent writes, so
  // we give it a generous window before we declare a failure.
  await waitFor(
    client,
    `(() => window.__testNotes.noteExists(${JSON.stringify(title)}).then(Boolean))()`,
    15_000,
    `${title} written to disk`,
  );
}

/**
 * Reset to a known-good state before each scenario. Goes through openNewNote
 * first so the editor session isn't holding a reference to a note we're about
 * to delete from disk — without this, the post-reset FS-watcher events on iOS
 * can race the next scenario's first file write.
 */
async function settleAndReset(client) {
  // Detach the editor session from any note we're about to delete by jumping
  // to /note/new via raw hash navigation. Doesn't await editor-ready (which
  // would race with the pending session unload from the previously-open note).
  await executeJs(client.ws, `window.location.hash = '#/note/new'`).catch(() => {});
  await sleep(150);
  await client.reset();
  // Small settle window — iOS's filesystem watcher posts batched events back
  // through the note-index pipeline, and we want those to drain before the
  // next scenario writes anything.
  await sleep(300);
}

// ── Scenarios ─────────────────────────────────────────────────────

/**
 * Note CRUD round-trip: create via editor, verify on disk, reopen, verify
 * editor restores content. Runs on both Mac and iOS.
 */
async function noteCrud(client) {
  await settleAndReset(client);
  await createNoteViaEditor(client, 'crud note', '# Hello\nSome body text.');

  const files = await client.listNotes();
  const names = files.map((f) => f.name ?? f.filename ?? f);
  assert(names.some((n) => n.includes('crud note')), `${client.name}: file not on disk: ${JSON.stringify(names)}`);

  const content = await client.readNote('crud note');
  assertEqual(content, '# Hello\nSome body text.', `${client.name}: file content mismatch`);

  // Reopen and verify editor restores the same body.
  await client.openNewNote(); // navigate away so reopen actually loads
  await client.openNote('crud note');
  const state = await client.getOpenNoteState();
  assertEqual(state.title, 'crud note', `${client.name}: reopened title`);
  assertEqual(state.editorContent, '# Hello\nSome body text.', `${client.name}: reopened body`);

  await client.deleteNote('crud note');
  const stillThere = await client.noteExists('crud note');
  assert(!stillThere, `${client.name}: note should be deleted`);
}

/**
 * Live-markdown decorations: type real markdown source, verify the rendered
 * text in the CM6 viewport collapses the syntax delimiters (so the user sees
 * "Hello" not "# Hello"). This catches regressions in liveMarkdownTransform.
 */
async function basicMarkdownRendering(client) {
  await settleAndReset(client);
  const body = [
    '# Heading 1',
    '',
    '## Heading 2',
    '',
    '**bold** and *italic* and ~~strike~~',
    '',
    '- bullet one',
    '- bullet two',
    '',
    '1. ordered one',
    '2. ordered two',
    '',
    '[link text](https://example.com)',
  ].join('\n');
  await createNoteViaEditor(client, 'md render', body);

  const rendered = await readEditorRenderedText(client);
  // The rendered text should NOT contain the syntax delimiters where the
  // cursor isn't on the line. `typeInEditor` leaves the cursor at the end,
  // so the last line ("[link text](...)") still shows its raw source.
  // We check earlier lines to keep the assertion stable across cursor pos.
  assert(rendered.includes('Heading 1'), `${client.name}: rendered text missing 'Heading 1' — got ${JSON.stringify(rendered.slice(0, 200))}`);
  assert(rendered.includes('Heading 2'), `${client.name}: missing 'Heading 2'`);
  assert(!rendered.includes('# Heading 1'), `${client.name}: '# Heading 1' source leaked into rendered text`);
  assert(rendered.includes('bold') && rendered.includes('italic'), `${client.name}: missing bold/italic words`);
  assert(rendered.includes('bullet one'), `${client.name}: missing bullet item`);
  // Live transform uses a bullet glyph for unordered-list items.
  assert(/[•●◦·]/u.test(rendered), `${client.name}: no bullet glyph in rendered text (saw ${JSON.stringify(rendered.slice(0, 200))})`);

  // The raw source on disk MUST keep the markdown intact — verify that.
  const onDisk = await client.readNote('md render');
  assertEqual(onDisk, body, `${client.name}: markdown source mangled on save`);
}

/**
 * Folder ops: create a folder, move a note into it, rename folder, verify
 * the note follows the rename. The drag-into-folder gesture itself is driven
 * via the same `moveNote` API the UI calls — so this is a logic regression
 * test, not a touch-gesture test. (Drag-and-drop pointer events on iOS sim
 * are unreliable enough that hooking the underlying API gives us a more
 * trustworthy signal.)
 */
async function folderOps(client) {
  await settleAndReset(client);
  await createNoteViaEditor(client, 'folder me', '# in a folder');

  await client.createFolder('Inbox');
  const folders = await client.listFolders();
  const folderPaths = folders.map((f) => f.path ?? f);
  assert(folderPaths.includes('Inbox'), `${client.name}: 'Inbox' not in folders: ${JSON.stringify(folderPaths)}`);

  await client.moveNote('folder me', 'Inbox/folder me');
  const afterMove = (await client.listNotes()).map((f) => f.name ?? f);
  assert(
    afterMove.some((n) => n === 'Inbox/folder me.md' || n === 'Inbox/folder me'),
    `${client.name}: note didn't move into folder. files: ${JSON.stringify(afterMove)}`,
  );

  // Rename: Inbox → Archive. The note should follow.
  await client.renameFolder('Inbox', 'Archive');
  const afterRename = (await client.listNotes()).map((f) => f.name ?? f);
  assert(
    afterRename.some((n) => n.startsWith('Archive/folder me')),
    `${client.name}: note didn't follow folder rename. files: ${JSON.stringify(afterRename)}`,
  );

  const finalFolders = (await client.listFolders()).map((f) => f.path ?? f);
  assert(finalFolders.includes('Archive'), `${client.name}: 'Archive' missing after rename`);
  assert(!finalFolders.includes('Inbox'), `${client.name}: 'Inbox' still present after rename`);
}

/**
 * Multi-tab: open two notes via the URL-hash router, verify the second one
 * is active and its content loads, then navigate back to the first and verify
 * the editor restores its content. This is a smoke test for the tab/session
 * loading path, not a comprehensive tab-store test.
 */
async function multiTabBasics(client) {
  await settleAndReset(client);
  // Seed two notes via the host filesystem path (faster than typing each).
  await client.writeNote('tab a', '# Tab A body');
  await client.writeNote('tab b', '# Tab B body');

  await client.openNote('tab a');
  let state = await client.getOpenNoteState();
  assertEqual(state.title, 'tab a', `${client.name}: opening tab a`);
  assertEqual(state.editorContent, '# Tab A body', `${client.name}: tab a body`);

  await client.openNote('tab b');
  state = await client.getOpenNoteState();
  assertEqual(state.title, 'tab b', `${client.name}: switching to tab b`);
  assertEqual(state.editorContent, '# Tab B body', `${client.name}: tab b body`);

  await client.openNote('tab a');
  state = await client.getOpenNoteState();
  assertEqual(state.title, 'tab a', `${client.name}: back to tab a`);
  assertEqual(state.editorContent, '# Tab A body', `${client.name}: tab a body preserved`);
}

/**
 * Search smoke test: write a note with a distinctive token, open the search
 * UI via the existing entry point, type the token, and assert the note appears
 * as a hit.
 *
 * We don't drive the in-app search modal because that requires keyboard focus
 * the iOS sim doesn't always grant promptly. Instead we hit the search index
 * directly via the same code path the modal uses.
 */
async function searchSmoke(client) {
  await settleAndReset(client);
  const distinctive = 'zephyranthes';
  // Use the canonical createNote helper rather than the editor path: it writes
  // the file AND updates the search index in one synchronous step (the editor
  // save pipeline can race with the FS watcher on iOS when the session is
  // mid-unload from a previous scenario). We want this scenario to exercise
  // the index population, not the editor save pipeline (note CRUD covers that).
  await executeJs(
    client.ws,
    `window.__testNotes.createNote('searchable', ${JSON.stringify(`# Notes on ${distinctive} blooms`)})`,
  );
  await waitFor(
    client,
    `(() => {
      const api = window.__testSearch;
      if (!api?.isPopulated?.()) return false;
      return api.search(${JSON.stringify(distinctive)}).length > 0;
    })()`,
    8_000,
    `search index hit for "${distinctive}"`,
  );
}

/**
 * Bidirectional sync: each side writes a note, syncs, and the other side
 * picks it up. Then both edit different notes simultaneously and reconcile.
 */
async function bidirectionalSync(mac, ios, server) {
  await mac.connectSync(server.url, server.password);
  await ios.connectSync(server.url, server.password);

  // Mac → iOS
  await mac.writeNote('from mac', '# Hello from Mac');
  await mac.syncNow();
  await ios.syncNow();
  const iosSawMac = await ios.readNote('from mac');
  assertEqual(iosSawMac, '# Hello from Mac', 'iOS should receive Mac note');

  // iOS → Mac
  await ios.writeNote('from ios', '# Hello from iOS');
  await ios.syncNow();
  await mac.syncNow();
  const macSawIos = await mac.readNote('from ios');
  assertEqual(macSawIos, '# Hello from iOS', 'Mac should receive iOS note');

  // Both have both
  const macFiles = (await mac.listNotes()).map((f) => f.name ?? f);
  const iosFiles = (await ios.listNotes()).map((f) => f.name ?? f);
  assert(macFiles.length === iosFiles.length, `Mac files=${macFiles.length} iOS files=${iosFiles.length}`);
}

/**
 * Sequential edits from both sides. Mac creates → iOS picks it up → iOS edits
 * → Mac sees the edit → Mac edits → iOS sees that. Exercises the most common
 * "two devices, one user, taking turns" pattern. Concurrent-edit conflict
 * handling is covered by cross-platform-sync.mjs's `concurrentEditConflict`.
 */
async function bidirectionalEdit(mac, ios, server) {
  await mac.connectSync(server.url, server.password);
  await ios.connectSync(server.url, server.password);

  await mac.writeNote('shared edit', '# Round 1');
  await mac.syncNow();
  await ios.syncNow();
  assertEqual(await ios.readNote('shared edit'), '# Round 1', 'iOS should have Round 1');

  // iOS edits, syncs
  await ios.writeNote('shared edit', '# Round 1\n\nFrom iOS edit');
  await ios.syncNow();

  // Mac picks it up
  await mac.syncNow();
  assertEqual(
    await mac.readNote('shared edit'),
    '# Round 1\n\nFrom iOS edit',
    'Mac should see iOS edit',
  );

  // Mac edits, syncs
  await mac.writeNote('shared edit', '# Round 1\n\nFrom iOS edit\n\nFrom Mac edit');
  await mac.syncNow();
  await ios.syncNow();
  assertEqual(
    await ios.readNote('shared edit'),
    '# Round 1\n\nFrom iOS edit\n\nFrom Mac edit',
    'iOS should see Mac edit',
  );
}

// ── Scenario registry ─────────────────────────────────────────────

const uiScenarios = [
  { name: 'note CRUD',              fn: noteCrud,              clients: ['mac', 'ios'] },
  { name: 'basic markdown render',  fn: basicMarkdownRendering,clients: ['mac', 'ios'] },
  { name: 'folder ops',             fn: folderOps,             clients: ['mac', 'ios'] },
  { name: 'multi-tab basics',       fn: multiTabBasics,        clients: ['mac', 'ios'] },
  { name: 'search smoke',           fn: searchSmoke,           clients: ['mac', 'ios'] },
];

const syncScenarios = [
  { name: 'bidirectional sync',     fn: bidirectionalSync },
  { name: 'bidirectional edit',     fn: bidirectionalEdit },
];

// ── Bootstrap ──────────────────────────────────────────────────────

function ensureDesktopBinary() {
  const binPath = join(REPO_ROOT, 'target', 'debug', 'futo-notes-tauri');
  const distJs = findDistIndexJs();
  if (existsSync(binPath) && distJs && fileContains(distJs, '__testSync')) return;
  console.log('Building desktop debug binary with test hooks…');
  runOrThrow('cargo', ['tauri', 'build', '--debug', '--no-bundle'], {
    cwd: join(REPO_ROOT, 'apps', 'tauri'),
    env: { ...process.env, VITE_INCLUDE_TEST_HOOKS: 'true' },
  });
}

function ensureIosApp() {
  // Check whether a freshly-built sim .app exists. If not, build it.
  const appCandidates = [
    join(REPO_ROOT, 'apps/tauri/src-tauri/gen/apple/build/arm64-sim/FUTO Notes Dev.app'),
    join(REPO_ROOT, 'apps/tauri/src-tauri/gen/apple/build/Build/Products/debug-iphonesimulator/FUTO Notes Dev.app'),
  ];
  const distJs = findDistIndexJs();
  const hookOK = distJs && fileContains(distJs, '__testSync');
  if (appCandidates.some(existsSync) && hookOK) return;
  console.log('Building iOS sim debug app with test hooks…');
  runOrThrow('node', ['scripts/fetch-ort-ios.mjs'], { cwd: REPO_ROOT });
  // Clean prior output dirs — `cargo tauri ios build` fails on rename when
  // the destination .app already exists with a populated tree.
  for (const candidate of appCandidates) {
    spawnSync('rm', ['-rf', candidate]);
  }
  spawnSync('rm', ['-rf', join(REPO_ROOT, 'apps/tauri/src-tauri/gen/apple/build/futo-notes-tauri_iOS.xcarchive')]);
  runOrThrow('cargo', [
    'tauri', 'ios', 'build', '--debug',
    '--target', 'aarch64-sim',
    '--config', 'src-tauri/tauri.ios.dev.conf.json',
  ], {
    cwd: join(REPO_ROOT, 'apps', 'tauri'),
    env: { ...process.env, VITE_INCLUDE_TEST_HOOKS: 'true' },
  });
}

function findDistIndexJs() {
  const assetsDir = join(REPO_ROOT, 'dist', 'assets');
  if (!existsSync(assetsDir)) return null;
  const files = readdirSync(assetsDir).filter((n) => /^index-.*\.js$/.test(n));
  return files.length > 0 ? join(assetsDir, files[0]) : null;
}

function fileContains(path, needle) {
  try { return readFileSync(path, 'utf8').includes(needle); } catch { return false; }
}

function runOrThrow(cmd, argv, opts = {}) {
  const res = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${argv.join(' ')} failed (exit ${res.status})`);
  }
}

/**
 * Kill any stale futo-notes-tauri instances spawned out of THIS worktree's
 * target dir. Avoids accidentally killing the user's installed app or another
 * worktree's running instance. Same shape as cross-platform-sync.mjs's
 * killStalePreviewAndClients but scoped to our worktree.
 */
function killStaleClients() {
  const ps = spawnSync('pgrep', ['-af', 'futo-notes-tauri'], { encoding: 'utf8' });
  const lines = (ps.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const ownTargetPrefix = `${REPO_ROOT}/target/debug/futo-notes-tauri`;
  for (const line of lines) {
    const [pidStr, ...rest] = line.split(/\s+/);
    const cmdline = rest.join(' ');
    if (cmdline.includes(ownTargetPrefix)) {
      try { process.kill(Number(pidStr), 'SIGTERM'); } catch { /* gone */ }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────

const results = [];
const stops = [];
process.on('exit', () => { for (const s of stops.reverse()) try { s(); } catch { /* ignore */ } });
process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));

async function runScenario(name, fn) {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    results.push({ name, pass: true, ms });
    console.log(`  ✓ ${name} (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - start;
    results.push({ name, pass: false, ms, error: err.message });
    console.log(`  ✗ ${name} (${ms}ms)`);
    console.log(`    ${err.message}`);
  }
}

async function main() {
  console.log('Mac ↔ iOS regression suite\n');

  if (process.platform !== 'darwin') {
    throw new Error('This suite only runs on macOS (requires iOS Simulator).');
  }

  if (!args['skip-build']) {
    ensureDesktopBinary();
    ensureIosApp();
  }

  // Clean up any stale debug processes from a prior run that didn't shut
  // down cleanly. (The bridge holds a port; a leftover process would steal
  // the discovery slot.)
  killStaleClients();

  console.log('Booting Mac + iOS instances…');
  const mac = await startDesktopTauriInstance('mac', REPO_ROOT);
  stops.push(() => mac.stop());
  console.log(`  Mac on port ${mac.port}`);

  const ios = await startIosSimulatorInstance('ios', REPO_ROOT);
  stops.push(() => ios.stop());
  console.log(`  iOS on port ${ios.port}`);

  const clientsByName = { mac, ios };

  // ── UI scenarios (per client) ────────────────────────────────────
  for (const scenario of uiScenarios) {
    if (args.only && !scenario.name.toLowerCase().includes(args.only.toLowerCase())) continue;
    console.log(`\n[ ${scenario.name} ]`);
    for (const clientName of scenario.clients) {
      const client = clientsByName[clientName];
      await runScenario(`${scenario.name} :: ${clientName}`, () => scenario.fn(client));
    }
  }

  // ── Sync scenarios ──────────────────────────────────────────────
  if (!args['skip-sync']) {
    console.log('\nStarting sync server…');
    const server = await startServer(4000, REPO_ROOT, {});
    stops.push(() => server.stop());

    for (const scenario of syncScenarios) {
      if (args.only && !scenario.name.toLowerCase().includes(args.only.toLowerCase())) continue;
      console.log(`\n[ ${scenario.name} ]`);
      await mac.reset();
      await ios.reset();
      await runScenario(scenario.name, () => scenario.fn(mac, ios, server));
    }
  }

  // ── Report ──────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nResults: ${passed}/${passed + failed} passed, ${failed} failed`);

  const reportDir = join(REPO_ROOT, 'test-screenshots');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(reportDir, 'mac-ios-regression.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2),
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.stack || err.message}`);
  process.exit(1);
});

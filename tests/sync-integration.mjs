#!/usr/bin/env node
/**
 * The Rust server-backed sync suites, against real servers, in ONE command.
 *
 *   node tests/sync-integration.mjs [-- extra cargo test args]
 *
 * `crates/futo-notes-sync/tests/server_integration.rs` holds two families that
 * need two DIFFERENT servers, and neither can be the other:
 *
 *   - the sync scenarios authenticate through the dev login, so they need a
 *     server in DEV mode. Against a hosted server every one of them fails
 *     `connect: Auth("unauthorized")`.
 *   - the hosted scenarios drive Log in with FUTO, checkout and billing, so
 *     they need a server in STAND-IN mode (`STANDIN_MODE=true`, hosted/OIDC
 *     against in-process fakes — the server's docs/adr/0009-stand-in-test-mode.md).
 *     A dev-mode server mounts none of those routes.
 *
 * Before this script that meant two invocations against two hand-started
 * servers, and no single command ran the file. This starts both on this
 * worktree's own slot-derived ports, points each family at its own with
 * $FUTO_TEST_SERVER and $FUTO_TEST_HOSTED_SERVER, runs the suites once, and
 * stops both servers by PID.
 *
 * The hosted leg only runs when the server this harness resolves can do
 * stand-in mode — see `standinMode` in scripts/sync-server-pin.json. When it
 * cannot, the run says so in full and the hosted scenarios stay covered by the
 * in-test stub (`cargo test -p futo-notes-sync --test hosted_setup`). It is
 * never quietly skipped, and a stand-in server that is asked for and does not
 * answer as one fails the run rather than skipping it.
 */

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { standinModeAvailable } from '../scripts/lib/sync-server.mjs';
import { portsFor } from '../scripts/lib/slot.mjs';
import { startServer } from './lib/sync-test-server.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything after a bare `--` (or every argument, when there is none) is
// handed to the test binary — that is how CI passes its `--skip`s.
const argv = process.argv.slice(2);
const extraTestArgs = argv[0] === '--' ? argv.slice(1) : argv;

const running = [];

async function stopEverything() {
  while (running.length) {
    const server = running.pop();
    try {
      server.stop();
    } catch {
      /* already gone */
    }
  }
}

// Terminate by the PID we started, never by process name: a pattern kill
// reaches every checkout on this machine (AGENTS.md M25).
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void stopEverything().then(() => process.exit(130));
  });
}

async function main() {
  const ports = portsFor(REPO_ROOT);
  const standin = standinModeAvailable();

  // Compile first, so neither server sits idle through a cold build — and so a
  // broken build fails in seconds instead of after two server starts.
  console.log('==> building the test binaries');
  const build = spawnSync(
    'cargo',
    [
      'test',
      '-p',
      'futo-notes-sync',
      '--test',
      'server_integration',
      '--test',
      'sse_live',
      '--no-run',
    ],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
  if (build.status !== 0) return build.status ?? 1;

  console.log(`==> starting the dev-mode server on ${ports.syncIntegration}`);
  const dev = await startServer(ports.syncIntegration, { mode: 'dev' });
  running.push(dev);
  console.log(`    ${dev.url}  (${dev.source}, pid ${dev.proc.pid}, db under ${dev.dataDir})`);

  let hosted = null;
  if (standin.available) {
    console.log(`==> starting the stand-in-mode server on ${ports.syncIntegrationHosted}`);
    hosted = await startServer(ports.syncIntegrationHosted, { mode: 'standin' });
    running.push(hosted);
    console.log(
      `    ${hosted.url}  (${hosted.source}, pid ${hosted.proc.pid}, db under ${hosted.dataDir})`,
    );
  } else {
    // Loud, and specific about what would change it. A reader must never have
    // to guess whether the hosted scenarios ran.
    console.log(
      [
        '',
        '==> hosted scenarios: NOT RUN against a real server',
        `    ${standin.why}.`,
        '    They still run against the in-test stub:',
        '      cargo test -p futo-notes-sync --test hosted_setup',
        `    To run them here, either point FUTO_NOTES_E2EE_SERVER_REPO at a`,
        '    futo-notes-server checkout that has stand-in mode and set',
        '    FUTO_NOTES_E2EE_SERVER_STANDIN=1, or bump the pin to a release that',
        '    carries futo-notes-server#14-#17 and set "standinMode": true.',
        '',
      ].join('\n'),
    );
  }

  const testArgs = [
    'test',
    '-p',
    'futo-notes-sync',
    '--test',
    'server_integration',
    '--test',
    'sse_live',
    '--',
    '--ignored',
    // One stand-in account, one shared dev vault: two scenarios in flight would
    // fight over both.
    '--test-threads=1',
    ...extraTestArgs,
  ];
  console.log(`==> cargo ${testArgs.join(' ')}`);
  const status = await new Promise((resolve) => {
    const proc = spawn('cargo', testArgs, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        FUTO_TEST_SERVER: dev.url,
        ...(hosted ? { FUTO_TEST_HOSTED_SERVER: hosted.url } : {}),
      },
    });
    proc.on('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });

  if (status !== 0) {
    console.error(`\n--- dev-mode server (${dev.url}) said ---\n${dev.log()}`);
    if (hosted) console.error(`\n--- stand-in server (${hosted.url}) said ---\n${hosted.log()}`);
  }

  console.log(
    status === 0
      ? hosted
        ? `\nsync integration green: dev-mode + stand-in-mode, against ${dev.source}`
        : `\nsync integration green: dev-mode only against ${dev.source} — the hosted scenarios did NOT run against a real server (see above)`
      : '\nsync integration FAILED',
  );
  return status;
}

// Anything that throws is a FAILED run, never a skipped leg (M11) — hence the
// failing default, which only a clean `main()` replaces.
let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error(err instanceof Error ? err.stack : String(err));
} finally {
  await stopEverything();
}
process.exit(exitCode);

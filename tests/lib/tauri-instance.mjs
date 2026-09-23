/**
 * Desktop Tauri instance launcher for cross-platform sync tests.
 */

import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  openSync,
  closeSync,
  accessSync,
  lstatSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { candidateFor, verifyTarget, worktreeRoots } from '../../scripts/qa-target.mjs';
import { portsFor } from '../../scripts/lib/slot.mjs';
import { discoverPort, connectWs } from './mcp-client.mjs';
import { TauriTestClient, waitForTestHooks } from './tauri-test-client.mjs';

// Reject escapes and symlinks before creating directories or starting the app.
function assertRunPath(value, base) {
  const rel = relative(resolve(base), resolve(value));
  if (!rel || rel === '..' || rel.startsWith('..' + sep))
    throw new Error('Desktop storage must stay inside its run directory');
  let part = resolve(base);
  for (const segment of ['', ...rel.split(sep)]) {
    part = join(part, segment);
    if (lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error('Desktop storage symlink escapes run ownership');
  }
}

/**
 * @param {string} name
 * @param {string} repoRoot
 * @param {{ reuse?: import('./tauri-test-client.mjs').TauriTestClient, env?: Record<string,string>, storage?: { instanceDir: string, dataDir: string, notesDir: string } }} [options]
 *   `reuse` relaunches an existing client's data dir and notes dir into the
 *   same client object — see `restartDesktopTauriInstance`. `storage` resumes
 *   a previously provisioned run directory (e.g. across separate invocations
 *   of a resumable verification run) without an in-memory client to reuse.
 */
export async function startDesktopTauriInstance(name, repoRoot, options = {}) {
  const { reuse = null, env: extraEnv = {}, storage } = options;
  const parent = process.env.FUTO_VERIFICATION_DIR || join(repoRoot, '.tauri-data');
  assertRunPath(parent, repoRoot);
  mkdirSync(parent, { recursive: true });
  const instanceDir =
    reuse?.storage?.instanceDir || storage?.instanceDir || mkdtempSync(join(parent, 'desktop-'));
  assertRunPath(instanceDir, parent);
  const dataDir = join(instanceDir, 'data');
  const notesDir = join(instanceDir, 'notes');
  if (storage && (storage.dataDir !== dataDir || storage.notesDir !== notesDir))
    throw new Error('Desktop storage must use the original run directories');
  assertRunPath(dataDir, instanceDir);
  assertRunPath(notesDir, instanceDir);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(notesDir, { recursive: true });

  if (!reuse && !storage)
    writeFileSync(join(dataDir, 'notes-dir-override.json'), JSON.stringify({ notesDir }));

  const logFile = join(instanceDir, `app-${randomUUID()}.log`);

  const candidates = [
    join(repoRoot, 'target', 'debug', 'futo-notes-tauri'),
    join(repoRoot, 'apps', 'tauri', 'src-tauri', 'target', 'debug', 'futo-notes-tauri'),
  ];
  let binaryPath;
  for (const candidate of candidates) {
    try {
      accessSync(candidate);
      binaryPath = candidate;
      break;
    } catch {
      /* try next */
    }
  }
  if (!binaryPath) {
    // This harness deliberately assumes the REPO-LOCAL target/ — see
    // REMOTE_CARGO_TARGET_DIR in scripts/remote-test.mjs for why the repo does
    // not relocate it. With CARGO_TARGET_DIR exported, cargo writes the binary
    // somewhere else and this used to fail as a bare "not found" AFTER an
    // 84-second build, naming nothing (pc_f7e52544227e). Say what is actually
    // going on.
    const relocated = process.env.CARGO_TARGET_DIR;
    throw new Error(
      [
        `Debug binary not found. Looked in:`,
        ...candidates.map((c) => `  ${c}`),
        relocated
          ? `\nCARGO_TARGET_DIR is set to '${relocated}', so cargo put the binary there ` +
            `instead. This harness requires the repo-local path — ` +
            `unset CARGO_TARGET_DIR and re-run.`
          : `\nRun from the repo root: just build-desktop-test`,
      ].join('\n'),
    );
  }

  const logFd = openSync(logFile, 'w');
  const proc = spawn(binaryPath, [], {
    env: {
      ...process.env,
      FUTO_NOTES_DATA_DIR: dataDir,
      FUTO_NOTES_MULTI_INSTANCE: '1',
      FUTO_MCP_BASE_PORT: String(portsFor(repoRoot).mcp),
      WEBKIT_DISABLE_DMABUF_RENDERER: '1',
      ...extraEnv,
    },
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);

  let port;
  try {
    port = await discoverPort(logFile, 60_000);
  } catch (err) {
    proc.kill('SIGKILL');
    throw new Error(`${name}: MCP bridge port not found — ${err.message}`, { cause: err });
  }

  let ws;
  try {
    const target = verifyTarget(candidateFor(proc.pid), {
      selfRoot: repoRoot,
      worktreeRoots: worktreeRoots(repoRoot),
      home: homedir(),
    });
    if (target.verdict !== 'verified') throw new Error(JSON.stringify(target.refusals));
    writeFileSync(
      join(instanceDir, `target-${proc.pid}.json`),
      JSON.stringify(
        {
          ...target,
          binarySha256: createHash('sha256').update(readFileSync(binaryPath)).digest('hex'),
          port,
          engine: process.platform === 'darwin' ? 'WKWebView' : 'WebKitGTK',
        },
        null,
        2,
      ),
    );
    ws = await connectWs(port);
    // Probe immediately: the MCP bridge often becomes discoverable only after
    // the webview is already ready. Retries preserve the same 90s CI budget
    // without charging every successful launch a fixed five-second delay.
    await waitForTestHooks(ws, name, { initialDelayMs: 0, attempts: 45, intervalMs: 2_000 });
  } catch (err) {
    proc.kill('SIGKILL');
    throw new Error(`${name}: desktop startup failed — ${err.message}`, { cause: err });
  }

  if (reuse) {
    // Same object, new process: the suite holds one client reference for the
    // whole run, so a restart that handed back a different object would leave
    // every later scenario driving a dead websocket.
    reuse.proc = proc;
    reuse.ws = ws;
    reuse.port = port;
    reuse.logFile = logFile;
    return reuse;
  }

  const client = new TauriTestClient({
    name,
    platform: 'desktop',
    proc,
    ws,
    port,
    notesDir,
    dataDir,
    logFile,
  });
  client.storage = { instanceDir, dataDir, notesDir };
  return client;
}

/**
 * Quit this instance and open it again — same data dir, same notes dir, same
 * OS secret-store entries, a brand-new process with no in-memory session left.
 *
 * The only way to exercise anything that happens at LAUNCH: the suite starts
 * its clients once and reuses them across every scenario, so without this a
 * scenario can never see a cold start.
 *
 * `env` goes to the new process only. A hosted scenario passes
 * `FUTO_HOSTED_SERVER` so the relaunched app's own boot path — which asks Rust
 * for the compiled-in address, not the test's — points at that scenario's
 * stand-in server instead of the real service.
 */
export async function restartDesktopTauriInstance(client, repoRoot, { env = {} } = {}) {
  const proc = client.proc;
  client.stop();
  if (proc) await waitForExit(proc, 15_000);
  return startDesktopTauriInstance(client.name, repoRoot, { reuse: client, env });
}

/** Resolves when [proc] has exited, SIGKILLing it if it outstays [timeoutMs]. */
function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

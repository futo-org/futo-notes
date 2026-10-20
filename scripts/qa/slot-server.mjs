// qa.mjs per-slot sync server: server-start / server-stop, each worktree its own port, SQLite
// database and blob dir.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { portsFor, slotOf } from '../lib/slot.mjs';
import {
  acquireOwnedServerStart,
  assertServerOwner,
  claimServerOwner,
  releaseServerOwner,
  serverOwner,
  shouldCleanServerDir,
} from './qa-server-owner.mjs';
import {
  REPORTED_AUTH_MODE,
  SERVER_PASSWORD,
  serverCapabilities,
  serverProcessEnv,
  standinModeAvailable,
  syncServerBinary,
  syncServerEnv,
} from '../lib/sync-server.mjs';
import { SRV_DIR, die, info, sleep, worktreeRoot } from './pool.mjs';

// ── per-slot sync server ───────────────────────────────────────────────────

export const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
export const readPid = (p) => Number((tryReadFile(p) || '').trim()) || null;
const tryReadFile = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
export const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * `--standin` starts the server in hosted stand-in test mode instead of
 * password mode: Log in with FUTO and the payment provider answered by
 * in-process fakes, which is what the hosted QA stories under docs/qa/ drive
 * the native apps against. A server that ignores STANDIN_MODE boots in its
 * default mode and looks perfectly healthy, so the mode is read back from the
 * capability document before this reports success (M11).
 */
export async function cmdServerStart(args) {
  const standin = args.includes('--standin');
  if (standin) {
    const { available, why } = standinModeAvailable();
    if (!available) die(`--standin needs a server that has stand-in test mode: ${why}`);
  }
  const mode = standin ? 'standin' : 'password';
  const root = worktreeRoot();
  const slot = slotOf(root);
  const port = portsFor(root).sync;
  const dir = path.join(SRV_DIR, `s${slot}`);
  const pidFile = path.join(dir, 'server.pid');

  // The stable slot hash can collide. Never adopt a live server merely because
  // it occupies the same slot: the metadata records the owning worktree.
  const meta = readJson(path.join(dir, 'meta.json'));
  if (meta?.worktree && meta.worktree !== root) {
    die(
      `slot ${slot} sync server belongs to another worktree (${meta.worktree}); stop using this slot until its owner releases it`,
    );
  }
  try {
    assertServerOwner(dir, root);
  } catch (error) {
    die(error.message);
  }

  const existing = readPid(pidFile);
  if (existing && pidAlive(existing)) {
    if (!meta?.worktree) {
      die(
        `a live sync server occupies slot ${slot} but ownership metadata is missing; refusing to adopt or overwrite it`,
      );
    }
    try {
      claimServerOwner(dir, root);
    } catch (error) {
      die(error.message);
    }
    const running = readJson(path.join(dir, 'meta.json'))?.mode ?? 'password';
    if (running !== mode) {
      die(
        `a ${running}-mode server is already running on port ${port} (pid ${existing}). ` +
          `Stop it first: just qa-server-stop`,
      );
    }
    info(`already running: http://127.0.0.1:${port} (pid ${existing}, ${mode}, data ${dir})`);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  let createdOwner;
  let releaseStartLock;
  try {
    ({ createdOwner, release: releaseStartLock } = acquireOwnedServerStart(dir, root));
  } catch (error) {
    die(error.message);
  }

  // Each slot's server owns a SQLite database inside its own directory, so
  // parallel worktrees share nothing: no database server to reach, and nothing
  // one session can wipe out from under another.
  let serverEstablished = false;
  try {
    const { path: binary, source } = await syncServerBinary();
    const log = fs.openSync(path.join(dir, 'server.log'), 'a');
    const child = spawn(binary, [], {
      // cwd is the slot's own directory: the server reads a `.env` from wherever
      // it starts, and no checkout of ours should supply one by accident.
      cwd: dir,
      detached: true,
      stdio: ['ignore', log, log],
      // serverProcessEnv, not a spread: stand-in mode REFUSES TO BOOT next to an
      // inherited AUTH_MODE or OIDC_*, so those keys have to be deleted from the
      // child's environment rather than merged over.
      env: serverProcessEnv(syncServerEnv({ port, dataDir: dir, mode })),
    });
    child.unref();
    fs.writeFileSync(pidFile, String(child.pid));
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify(
        { worktree: root, port, mode, server: source, startedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    serverEstablished = true;
    releaseStartLock();
  } catch (error) {
    if (!serverEstablished) {
      const startedPid = readPid(pidFile);
      if (!startedPid || !pidAlive(startedPid)) {
        // No child survived the failed setup, so remove the temporary claim
        // and allow a clean retry.
        releaseStartLock();
        if (createdOwner) releaseServerOwner(dir, root);
      }
    }
    throw error;
  }

  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) break;
    } catch {}
    await sleep(1000);
    if (i === 29) die(`server did not become healthy — see ${path.join(dir, 'server.log')}`);
  }
  const reported = (await serverCapabilities(`http://127.0.0.1:${port}`)).auth_mode;
  if (reported !== REPORTED_AUTH_MODE[mode]) {
    stopServerDir(dir, readJson(path.join(dir, 'meta.json')), false);
    die(
      `asked for ${mode} mode but the server reports auth_mode "${reported}" — it ignored the ` +
        `setting, so it predates that mode. See ${path.join(dir, 'server.log')}`,
    );
  }
  info(`sync server: http://127.0.0.1:${port}  (Android emulator: http://10.0.2.2:${port})`);
  if (standin) {
    info(`mode: stand-in (Log in with FUTO and billing are fakes; loopback only)`);
    info(`  point a debug app at it — Android: --es futo_hosted_server http://10.0.2.2:${port}`);
    info(
      `                            iOS: SIMCTL_CHILD_FUTO_HOSTED_SERVER=http://127.0.0.1:${port}`,
    );
  } else {
    info(`password: ${SERVER_PASSWORD}`);
  }
  info(`data: ${dir}   log: ${path.join(dir, 'server.log')}`);
}

export function stopServerDir(dir, meta, drop) {
  if (fs.existsSync(path.join(dir, 'starting.lock'))) {
    die(`sync server start is in progress at ${dir}; refusing to stop or drop it`);
  }
  const owner = serverOwner(dir);
  const expectedOwner = owner?.worktree ?? meta?.worktree;
  if (!expectedOwner)
    die(`sync server ownership is unknown at ${dir}; refusing to stop or drop it`);
  if (owner && meta?.worktree && owner.worktree !== meta.worktree) {
    die(`sync server owner record and metadata disagree at ${dir}; refusing to stop or drop it`);
  }
  try {
    assertServerOwner(dir, expectedOwner);
  } catch (error) {
    die(error.message);
  }
  const pid = readPid(path.join(dir, 'server.pid'));
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid);
    } catch {}
    info(`stopped server pid ${pid}`);
  }
  fs.rmSync(path.join(dir, 'server.pid'), { force: true });
  releaseServerOwner(dir, expectedOwner);
  if (drop && meta) {
    // The database is a file in this directory, so one delete takes the whole
    // slot: SQLite database, blobs, log. `dir` is always <state>/server/s<slot>,
    // never a computed ancestor.
    fs.rmSync(dir, { recursive: true, force: true });
    info(`dropped this slot's database and blobs (${dir})`);
  }
}

export function serverStop(root, drop) {
  const dir = path.join(SRV_DIR, `s${slotOf(root)}`);
  const meta = readJson(path.join(dir, 'meta.json'));
  const owner = serverOwner(dir);
  const pid = readPid(path.join(dir, 'server.pid'));
  if (!meta && !owner && !pid) return;
  if (fs.existsSync(path.join(dir, 'starting.lock'))) {
    die(`sync server start is in progress at ${dir}; refusing to stop or drop it`);
  }
  if (owner && owner.worktree !== root) {
    die(
      `slot ${slotOf(root)} sync server belongs to another worktree (${owner.worktree}); refusing to stop or drop it`,
    );
  }
  if (!owner && (!meta?.worktree || meta.worktree !== root)) {
    die(`slot ${slotOf(root)} sync server ownership is unknown; refusing to stop or drop it`);
  }
  if (!owner && meta?.worktree === root) claimServerOwner(dir, root); // safely adopt a legacy owned server
  if (shouldCleanServerDir({ meta, owner, pid })) stopServerDir(dir, meta, drop);
}

#!/usr/bin/env node
// Parallel-QA isolation: per-worktree devices and sync servers.
//
// Multiple Claude Code sessions (or humans) can QA different worktrees on one
// machine without colliding. The model mirrors the /verify skill's port
// scheme: the worktree path hashes to a SLOT, and the slot deterministically
// claims pooled devices (iOS simulators + Android AVDs named futo-qa-0..6)
// and a sync server (per-slot port + per-slot Postgres DATABASE so parallel
// runs can't TRUNCATE each other's data).
//
// Ownership is an owner-file per device under ~/.futo-notes-qa/devices/,
// containing the claiming worktree path. Staleness is self-healing: an owner
// whose worktree directory no longer exists is reclaimable — no TTLs, no
// heartbeats. Pool devices are the ONLY devices this tool touches; your own
// simulators/AVDs are never claimed, booted, or deleted.
//
//   node scripts/qa.mjs claim [ios|android|all]   # ensure+boot devices, print exports
//   node scripts/qa.mjs status                    # pool devices + servers, owners, state
//   node scripts/qa.mjs release [--shutdown]      # release this worktree's claims
//   node scripts/qa.mjs gc                        # reap devices/servers of deleted worktrees
//   node scripts/qa.mjs server-start              # per-slot sync server (bun + own Postgres DB)
//   node scripts/qa.mjs server-stop [--drop]      # stop it; --drop also drops the DB + blobs
//
// `claim` prints `export SIM=…` / `export ANDROID_SERIAL=…` lines on stdout
// (progress goes to stderr), so shells can `eval "$(node scripts/qa.mjs claim all)"`.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const POOL = 7; // devices per platform; bump if you routinely run more worktrees
const IS_MAC = process.platform === 'darwin';
const HOME = os.homedir();
const STATE = path.join(HOME, '.futo-notes-qa');
const DEV_DIR = path.join(STATE, 'devices');
const SRV_DIR = path.join(STATE, 'server');
const ANDROID_HOME =
  process.env.ANDROID_HOME || path.join(HOME, IS_MAC ? 'Library/Android/sdk' : 'Android/Sdk');
const EMULATOR = path.join(ANDROID_HOME, 'emulator/emulator');
const AVDMANAGER = path.join(ANDROID_HOME, 'cmdline-tools/latest/bin/avdmanager');
const SDKMANAGER = path.join(ANDROID_HOME, 'cmdline-tools/latest/bin/sdkmanager');
const SIM_DEVICE_TYPE = process.env.QA_SIM_DEVICE_TYPE || 'iPhone 17 Pro';
const PG_BASE = process.env.FUTO_NOTES_QA_PG || 'postgres://futo_notes:futo_notes@localhost:5433';

const info = (msg) => process.stderr.write(msg + '\n');
const die = (msg) => {
  process.stderr.write(`qa: ${msg}\n`);
  process.exit(1);
};
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const tryRun = (cmd, args, opts = {}) => {
  try {
    return run(cmd, args, opts);
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── worktree identity (must stay in sync with the /verify skill's bash) ────

function worktreeRoot() {
  const out = tryRun('git', ['rev-parse', '--show-toplevel']);
  if (!out) die('not inside a git worktree');
  return out.trim();
}

function slotOf(root) {
  const hex = crypto.createHash('md5').update(root).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % 50;
}

function branchOf(root) {
  return (tryRun('git', ['-C', root, 'branch', '--show-current']) || '').trim() || '(detached)';
}

// ── owner files ────────────────────────────────────────────────────────────

const ownerPath = (platform, name) => path.join(DEV_DIR, `${platform}-${name}.json`);

function readOwner(platform, name) {
  try {
    return JSON.parse(fs.readFileSync(ownerPath(platform, name), 'utf8'));
  } catch {
    return null;
  }
}

const ownerIsStale = (owner) => !fs.existsSync(owner.worktree);

// Atomically claim a device name for this worktree. Exclusive create (wx)
// makes two SIMULTANEOUS claimers of the same name resolve safely: exactly
// one wins, the loser re-reads and moves on. (Reclaiming a stale owner has a
// tiny overwrite race — acceptable: it requires two sessions claiming within
// milliseconds on behalf of an already-deleted worktree.)
function tryClaimOwner(platform, name, root) {
  fs.mkdirSync(DEV_DIR, { recursive: true });
  const payload = JSON.stringify(
    { worktree: root, branch: branchOf(root), claimedAt: new Date().toISOString() },
    null,
    2,
  );
  try {
    fs.writeFileSync(ownerPath(platform, name), payload, { flag: 'wx' });
    return true;
  } catch {
    const owner = readOwner(platform, name);
    if (owner && owner.worktree === root) return true; // already ours
    if (!owner || ownerIsStale(owner)) {
      fs.writeFileSync(ownerPath(platform, name), payload);
      return true;
    }
    return false;
  }
}

// Claim this worktree's pool device: start at slot % POOL, linear-probe past
// devices owned by other live worktrees, reclaim stale ones.
function claimPoolName(platform, root) {
  const start = slotOf(root) % POOL;
  for (let k = 0; k < POOL; k++) {
    const name = `futo-qa-${(start + k) % POOL}`;
    if (tryClaimOwner(platform, name, root)) return name;
  }
  die(`all ${POOL} ${platform} pool devices are owned by live worktrees — release one (just qa-release) or run just qa-gc`);
}

// ── iOS simulators ─────────────────────────────────────────────────────────

function simDevices() {
  const json = JSON.parse(run('xcrun', ['simctl', 'list', '-j', 'devices']));
  const out = [];
  for (const [runtime, devices] of Object.entries(json.devices)) {
    for (const d of devices) out.push({ ...d, runtime });
  }
  return out;
}

const findSim = (name) => simDevices().find((d) => d.name === name && d.isAvailable !== false);

async function ensureSim(name) {
  let sim = findSim(name);
  if (!sim) {
    info(`creating simulator ${name} (${SIM_DEVICE_TYPE})`);
    run('xcrun', ['simctl', 'create', name, SIM_DEVICE_TYPE]);
    sim = findSim(name);
    if (!sim) die(`simctl create ${name} did not produce a device`);
  }
  if (sim.state !== 'Booted') {
    info(`booting simulator ${name} (${sim.udid})`);
    tryRun('xcrun', ['simctl', 'boot', sim.udid]); // "already booted" is fine
    for (let i = 0; i < 30 && findSim(name)?.state !== 'Booted'; i++) await sleep(1000);
    if (findSim(name)?.state !== 'Booted') die(`simulator ${name} did not reach Booted`);
    tryRun('open', ['-a', 'Simulator']); // show the window; harmless if headless use
  }
  return findSim(name).udid;
}

// ── Android emulators ──────────────────────────────────────────────────────

const avdNames = () => (tryRun(EMULATOR, ['-list-avds']) || '').split('\n').filter(Boolean);

// serial → AVD name for every running emulator (physical devices are skipped)
function runningEmus() {
  const out = {};
  const devices = tryRun('adb', ['devices']) || '';
  for (const m of devices.matchAll(/^(emulator-\d+)\tdevice$/gm)) {
    const name = (tryRun('adb', ['-s', m[1], 'emu', 'avd', 'name']) || '').split('\n')[0].trim();
    if (name) out[name] = m[1];
  }
  return out;
}

function installedSystemImage() {
  const list = tryRun(SDKMANAGER, ['--list_installed']) || '';
  const images = [...list.matchAll(/^\s*(system-images;\S+)/gm)].map((m) => m[1]);
  if (!images.length)
    die(`no Android system image installed — e.g.: ${SDKMANAGER} "system-images;android-36;google_apis;${IS_MAC ? 'arm64-v8a' : 'x86_64'}"`);
  const arch = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  // Pick the HIGHEST API level for the host arch. sdkmanager lists images
  // alphabetically, so a plain `.find()` grabs android-30 before android-36 and
  // silently claims a stale emulator — API-35+ behavior (e.g. enforced
  // edge-to-edge) then goes untested. Rank by the numeric API in `android-<N>`;
  // preview/codename images (non-numeric) sort last.
  const apiLevel = (i) => {
    const m = i.match(/;android-(\d+);/);
    return m ? Number(m[1]) : -1;
  };
  const candidates = images.filter((i) => i.includes(arch)).sort((a, b) => apiLevel(b) - apiLevel(a));
  return candidates[0] || images[0];
}

async function ensureAvd(name) {
  if (!avdNames().includes(name)) {
    const image = installedSystemImage();
    info(`creating AVD ${name} (${image})`);
    // avdmanager prompts "create a custom hardware profile?" — answer no.
    const res = spawnSync(AVDMANAGER, ['create', 'avd', '-n', name, '-k', image], {
      input: 'no\n',
      encoding: 'utf8',
    });
    if (res.status !== 0) die(`avdmanager create failed:\n${res.stderr || res.stdout}`);
  }
  let serial = runningEmus()[name];
  if (!serial) {
    info(`booting emulator ${name} (first boot can take a couple of minutes)`);
    const child = spawn(EMULATOR, ['-avd', name], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 60 && !serial; i++) {
      await sleep(2000);
      serial = runningEmus()[name];
    }
    if (!serial) die(`emulator ${name} did not appear in adb devices`);
    for (let i = 0; i < 90; i++) {
      const boot = (tryRun('adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']) || '').trim();
      if (boot === '1') break;
      await sleep(2000);
      if (i === 89) die(`emulator ${name} (${serial}) did not finish booting`);
    }
  }
  return serial;
}

// ── commands ───────────────────────────────────────────────────────────────

async function cmdClaim(target = 'all') {
  const root = worktreeRoot();
  const wantIos = target === 'ios' || target === 'all';
  const wantAndroid = target === 'android' || target === 'all';
  if (target !== 'ios' && target !== 'android' && target !== 'all') die(`unknown target ${target}`);
  if (wantIos && !IS_MAC && target === 'ios') die('iOS simulators need macOS');

  const exports = [];
  if (wantIos && IS_MAC) {
    const name = claimPoolName('ios', root);
    const udid = await ensureSim(name);
    info(`ios: ${name} → ${udid}`);
    exports.push(`export SIM=${udid}`);
  } else if (wantIos) {
    info('ios: skipped (not macOS)');
  }
  if (wantAndroid) {
    const name = claimPoolName('android', root);
    const serial = await ensureAvd(name);
    info(`android: ${name} → ${serial}`);
    exports.push(`export ANDROID_SERIAL=${serial}`);
  }
  info('claimed for ' + root + ' (slot ' + slotOf(root) + '). Set these in your shell:');
  process.stdout.write(exports.join('\n') + '\n');
}

function myDevices(root) {
  const mine = [];
  if (!fs.existsSync(DEV_DIR)) return mine;
  for (const f of fs.readdirSync(DEV_DIR)) {
    const m = f.match(/^(ios|android)-(.+)\.json$/);
    if (!m) continue;
    const owner = readOwner(m[1], m[2]);
    if (owner?.worktree === root) mine.push({ platform: m[1], name: m[2] });
  }
  return mine;
}

function shutdownDevice(platform, name) {
  if (platform === 'ios') {
    const sim = IS_MAC && findSim(name);
    if (sim && sim.state === 'Booted') tryRun('xcrun', ['simctl', 'shutdown', sim.udid]);
  } else {
    const serial = runningEmus()[name];
    if (serial) tryRun('adb', ['-s', serial, 'emu', 'kill']);
  }
}

function cmdRelease(flags) {
  const root = worktreeRoot();
  for (const { platform, name } of myDevices(root)) {
    if (flags.includes('--shutdown')) shutdownDevice(platform, name);
    fs.rmSync(ownerPath(platform, name), { force: true });
    info(`released ${platform} ${name}`);
  }
  serverStop(root, false); // never leave an orphaned server running
}

function cmdGc() {
  if (fs.existsSync(DEV_DIR)) {
    for (const f of fs.readdirSync(DEV_DIR)) {
      const m = f.match(/^(ios|android)-(.+)\.json$/);
      if (!m) continue;
      const owner = readOwner(m[1], m[2]);
      if (!owner || !ownerIsStale(owner)) continue;
      info(`gc: ${m[1]} ${m[2]} owned by deleted worktree ${owner.worktree}`);
      shutdownDevice(m[1], m[2]);
      if (m[1] === 'ios' && IS_MAC) {
        const sim = findSim(m[2]);
        if (sim) tryRun('xcrun', ['simctl', 'delete', sim.udid]);
      } else if (m[1] === 'android') {
        tryRun(AVDMANAGER, ['delete', 'avd', '-n', m[2]]);
      }
      fs.rmSync(ownerPath(m[1], m[2]), { force: true });
    }
  }
  if (fs.existsSync(SRV_DIR)) {
    for (const d of fs.readdirSync(SRV_DIR)) {
      const meta = readJson(path.join(SRV_DIR, d, 'meta.json'));
      if (meta && !fs.existsSync(meta.worktree)) {
        info(`gc: server ${d} for deleted worktree ${meta.worktree}`);
        stopServerDir(path.join(SRV_DIR, d), meta, true);
      }
    }
  }
  info('gc done');
}

function cmdStatus() {
  const root = worktreeRoot();
  const emus = runningEmus();
  const platforms = IS_MAC ? ['ios', 'android'] : ['android'];
  for (const platform of platforms) {
    info(`— ${platform} pool (${POOL} max) —`);
    for (let i = 0; i < POOL; i++) {
      const name = `futo-qa-${i}`;
      const owner = readOwner(platform, name);
      let state = 'absent';
      if (platform === 'ios' && IS_MAC) {
        const sim = findSim(name);
        if (sim) state = sim.state === 'Booted' ? `booted ${sim.udid}` : 'shutdown';
      } else if (platform === 'android') {
        if (emus[name]) state = `booted ${emus[name]}`;
        else if (avdNames().includes(name)) state = 'shutdown';
      }
      if (state === 'absent' && !owner) continue;
      const who = owner
        ? `${owner.worktree}${owner.worktree === root ? ' (this worktree)' : ''}${ownerIsStale(owner) ? ' [STALE — qa-gc]' : ''} @ ${owner.branch}`
        : 'unclaimed';
      info(`  ${name}: ${state} — ${who}`);
    }
  }
  info('— sync servers —');
  if (fs.existsSync(SRV_DIR)) {
    for (const d of fs.readdirSync(SRV_DIR).sort()) {
      const meta = readJson(path.join(SRV_DIR, d, 'meta.json'));
      if (!meta) continue;
      const pid = readPid(path.join(SRV_DIR, d, 'server.pid'));
      const alive = pid && pidAlive(pid);
      info(`  ${d}: ${alive ? `running pid ${pid} port ${meta.port}` : 'stopped'} db ${meta.db} — ${meta.worktree}`);
    }
  }
}

// ── per-slot sync server ───────────────────────────────────────────────────

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const readPid = (p) => Number((tryReadFile(p) || '').trim()) || null;
const tryReadFile = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function serverRepo() {
  if (!tryRun('bun', ['--version'])) die('bun is required to run the sync server (https://bun.sh)');
  const repo = path.resolve(
    process.env.FUTO_NOTES_E2EE_SERVER_REPO || path.join(HOME, 'Developer', 'futo-notes-server'),
  );
  if (!fs.existsSync(path.join(repo, 'package.json')))
    die(`futo-notes-server not found at ${repo} — set FUTO_NOTES_E2EE_SERVER_REPO to your checkout`);
  return repo;
}

// Run a tiny pg script with bun from the server repo (its node_modules has
// `pg`), so we don't require psql on the host.
function pgQuery(repo, url, sql) {
  const script = `const {default:pg}=await import('pg');const c=new pg.Client(process.env.QA_PG_URL);await c.connect();try{await c.query(process.env.QA_PG_SQL)}finally{await c.end()}`;
  return spawnSync('bun', ['-e', script], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, QA_PG_URL: url, QA_PG_SQL: sql },
  });
}

async function cmdServerStart() {
  const root = worktreeRoot();
  const slot = slotOf(root);
  const port = 3100 + slot;
  const db = `futo_notes_qa_s${slot}`;
  const dir = path.join(SRV_DIR, `s${slot}`);
  const pidFile = path.join(dir, 'server.pid');
  const repo = serverRepo();

  const existing = readPid(pidFile);
  if (existing && pidAlive(existing)) {
    info(`already running: http://127.0.0.1:${port} (pid ${existing}, db ${db}, password testing123)`);
    return;
  }
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });

  // Reach Postgres; if it's down and docker exists, try the repo's compose.
  let ping = pgQuery(repo, `${PG_BASE}/postgres`, 'select 1');
  if (ping.status !== 0 && tryRun('docker', ['--version'])) {
    info('postgres unreachable — trying `docker compose up -d postgres` in the server repo');
    spawnSync('docker', ['compose', 'up', '-d', 'postgres'], { cwd: repo, stdio: 'inherit' });
    await sleep(3000);
    ping = pgQuery(repo, `${PG_BASE}/postgres`, 'select 1');
  }
  if (ping.status !== 0)
    die(
      `cannot reach Postgres at ${PG_BASE} — start it (server repo: docker compose up -d postgres; ` +
        `or a native install: brew install postgresql@16, then set FUTO_NOTES_QA_PG to its URL).\n${ping.stderr || ''}`,
    );

  const create = pgQuery(repo, `${PG_BASE}/postgres`, `CREATE DATABASE ${db}`);
  if (create.status !== 0 && !/already exists|42P04/.test(create.stderr || ''))
    die(`could not create ${db}:\n${create.stderr}`);

  const dbUrl = `${PG_BASE}/${db}`;
  const migrate = spawnSync('bun', ['run', 'migrate'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: dbUrl },
  });
  if (migrate.status !== 0) die(`migrations failed for ${db}:\n${migrate.stderr || migrate.stdout}`);

  const hash = run('bun', ['src/index.ts', 'hash', 'testing123'], { cwd: repo }).trim();
  const log = fs.openSync(path.join(dir, 'server.log'), 'a');
  const child = spawn('bun', ['src/index.ts'], {
    cwd: repo,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      PORT: String(port),
      BLOB_DIR: path.join(dir, 'blobs'),
      DATABASE_URL: dbUrl,
      AUTH_MODE: 'password',
      FUTO_NOTES_PASSWORD_HASH: hash,
    },
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ worktree: root, port, db, startedAt: new Date().toISOString() }, null, 2),
  );

  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) break;
    } catch {}
    await sleep(1000);
    if (i === 29) die(`server did not become healthy — see ${path.join(dir, 'server.log')}`);
  }
  info(`sync server: http://127.0.0.1:${port}  (Android emulator: http://10.0.2.2:${port})`);
  info(`password: testing123   db: ${db}   log: ${path.join(dir, 'server.log')}`);
}

function stopServerDir(dir, meta, drop) {
  const pid = readPid(path.join(dir, 'server.pid'));
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid);
    } catch {}
    info(`stopped server pid ${pid}`);
  }
  fs.rmSync(path.join(dir, 'server.pid'), { force: true });
  if (drop && meta) {
    const res = pgQuery(serverRepo(), `${PG_BASE}/postgres`, `DROP DATABASE IF EXISTS ${meta.db}`);
    if (res.status === 0) info(`dropped ${meta.db}`);
    else info(`could not drop ${meta.db} (postgres down?) — drop it manually later`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function serverStop(root, drop) {
  const dir = path.join(SRV_DIR, `s${slotOf(root)}`);
  const meta = readJson(path.join(dir, 'meta.json'));
  if (meta || readPid(path.join(dir, 'server.pid'))) stopServerDir(dir, meta, drop);
}

// ── main ───────────────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'claim':
    await cmdClaim(args[0] || 'all');
    break;
  case 'status':
    cmdStatus();
    break;
  case 'release':
    cmdRelease(args);
    break;
  case 'gc':
    cmdGc();
    break;
  case 'server-start':
    await cmdServerStart();
    break;
  case 'server-stop':
    serverStop(worktreeRoot(), args.includes('--drop'));
    break;
  default:
    die('usage: qa.mjs claim [ios|android|all] | status | release [--shutdown] | gc | server-start | server-stop [--drop]');
}

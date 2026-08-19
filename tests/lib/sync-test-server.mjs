/**
 * Sync test server launcher.
 *
 * Starts the E2EE futo-notes-server process with isolated blob storage.
 * Used by cross-platform sync tests to get a fresh server per scenario.
 *
 * Isolation is per worktree and enforced, not assumed: the port must be free
 * (never adopted from whoever answers), the healthy responder must be the child
 * we spawned, and the database is slot-derived so the per-scenario TRUNCATE can
 * only ever wipe this worktree's own rows.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { PG_BASE, pgQuery } from '../../scripts/lib/pg.mjs';
import { slotOf } from '../../scripts/lib/slot.mjs';
import { formatSpawnFailure } from '../../scripts/lib/spawn-result.mjs';

const PASSWORD = 'testing123';

const hashCache = new Map();
const readyComposeProjects = new Set();
const readyDatabases = new Set();

function hashPassword(serverRepo, password) {
  const cacheKey = `${serverRepo}\0${password}`;
  const cached = hashCache.get(cacheKey);
  if (cached) return cached;
  const result = spawnSync('bun', ['src/index.ts', 'hash', password], {
    cwd: serverRepo,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Failed to hash test server password: ${formatSpawnFailure(result, 'bun')}`);
  }
  const hash = result.stdout.trim();
  hashCache.set(cacheKey, hash);
  return hash;
}

/**
 * Start a fresh sync server on the given port.
 *
 * The caller owns the port (tests/cross-platform-sync.mjs allocates from this
 * worktree's slot band); the delay proxy, when requested, takes the port next
 * to it, so callers must allocate ports in pairs.
 *
 * @param {number} port
 * @param {string} repoRoot — client monorepo root
 * @param {{ syncDelayMs?: number }} [options]
 * @returns {Promise<{proc, port, dataDir, url, password, stop}>}
 */
export async function startServer(port, repoRoot, options = {}) {
  const syncDelayMs = options.syncDelayMs ?? 0;
  // When a delay proxy is requested, the real server moves one port up and the
  // proxy takes `port` (the address the clients were handed).
  const serverPort = syncDelayMs > 0 ? port + 1 : port;

  // Before anything else: refuse a port we do not own. A health check alone is
  // satisfied by a stranger, and adopting one is how two worktrees ended up
  // sharing a server and a database.
  await assertPortAvailable(serverPort, 'sync server');
  if (serverPort !== port) await assertPortAvailable(port, 'sync delay proxy');

  const dataDir = mkdtempSync(join(tmpdir(), 'sf-test-server-'));
  const blobDir = join(dataDir, 'blobs');
  const serverRepo = resolve(
    process.env.FUTO_NOTES_E2EE_SERVER_REPO || join(homedir(), 'Developer', 'futo-notes-server'),
  );

  if (!existsSync(join(serverRepo, 'package.json'))) {
    throw new Error(
      `E2EE server repo not found at ${serverRepo}. Set FUTO_NOTES_E2EE_SERVER_REPO to the futo-notes-server checkout.`,
    );
  }

  // If the caller provides a DATABASE_URL (e.g. CI with a services: postgres
  // sidecar), trust it and skip docker compose — the dind runner can't reach
  // a host-level compose container at localhost:5433 anyway.
  const externalDb = !!process.env.FUTO_NOTES_E2EE_DATABASE_URL;
  if (!externalDb && !readyComposeProjects.has(serverRepo)) {
    const compose = spawnSync('docker', ['compose', 'up', '-d', 'postgres'], {
      cwd: serverRepo,
      encoding: 'utf8',
    });
    if (compose.status !== 0) {
      throw new Error(`Failed to start E2EE server Postgres:\n${compose.stderr || compose.stdout}`);
    }
    readyComposeProjects.add(serverRepo);
  }

  const passwordHash = hashPassword(serverRepo, PASSWORD);
  const dbUrl = databaseUrl(repoRoot);
  if (!externalDb) ensureDatabase(serverRepo, dbUrl);

  const env = {
    ...process.env,
    PORT: String(serverPort),
    BLOB_DIR: blobDir,
    DATABASE_URL: dbUrl,
    AUTH_MODE: 'password',
    FUTO_NOTES_PASSWORD_HASH: passwordHash,
  };

  const proc = spawn('bun', ['src/index.ts'], {
    cwd: serverRepo,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Collect stderr for diagnostics on failure
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  // Wait for OUR server to be healthy: waitForHealth aborts if the child dies,
  // and assertListenerIsOurs covers the case measured on macOS, where a bun that
  // could not bind neither exits nor serves — it sits retrying Postgres while a
  // stranger answers /health on the port.
  const upstreamUrl = `http://127.0.0.1:${serverPort}`;
  await waitForHealth(`${upstreamUrl}/health`, 30_000, proc).catch((err) => {
    proc.kill('SIGKILL');
    throw new Error(
      `E2EE server failed to start on port ${serverPort}: ${err.message}\nstdout: ${stdout.slice(-500)}\nstderr: ${stderr.slice(-500)}`,
    );
  });
  assertListenerIsOurs(serverPort, proc.pid);

  // Only ever against this worktree's own database: on a shared one this wipes
  // a concurrent run's session rows, which that run reports as a spurious
  // "HTTP 401: session expired".
  const truncateSql = 'TRUNCATE orphaned_blobs, objects, collections, sessions, users CASCADE;';
  const reset = pgQuery(serverRepo, dbUrl, truncateSql);
  if (reset.status !== 0) {
    proc.kill('SIGKILL');
    throw new Error(`Failed to reset E2EE server database: ${formatSpawnFailure(reset, 'bun')}`);
  }

  let proxyServer = null;
  if (syncDelayMs > 0) {
    proxyServer = http.createServer(async (req, res) => {
      try {
        const targetUrl = new URL(req.url ?? '/', upstreamUrl);
        const body = await readRequestBody(req);

        if (
          syncDelayMs > 0 &&
          targetUrl.pathname.includes('/objects') &&
          ['GET', 'POST', 'PUT', 'DELETE'].includes(req.method ?? '')
        ) {
          await new Promise((resolve) => setTimeout(resolve, syncDelayMs));
        }

        const upstream = await fetch(targetUrl, {
          method: req.method,
          headers: req.headers,
          body: body.length > 0 ? body : undefined,
          duplex: 'half',
        });

        res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
        // Stream the body through instead of buffering via arrayBuffer(). The
        // desktop now opens a long-lived SSE stream (GET /api/sync/events) for
        // live sync; arrayBuffer() never resolves on a streaming response, which
        // hangs this proxy (and the catch's second writeHead would crash on
        // ERR_HTTP_HEADERS_SENT). Piping proxies SSE incrementally + finite
        // /objects responses alike.
        if (upstream.body) {
          const upstreamStream = Readable.fromWeb(upstream.body);
          upstreamStream.on('error', () => {
            if (!res.writableEnded) res.end();
          });
          res.on('close', () => upstreamStream.destroy());
          upstreamStream.pipe(res);
        } else {
          res.end();
        }
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' });
        }
        if (!res.writableEnded) {
          res.end(`Proxy error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    await new Promise((resolve, reject) => {
      proxyServer.once('error', reject);
      proxyServer.listen(port, '127.0.0.1', () => {
        proxyServer.off('error', reject);
        resolve();
      });
    });
  }

  const url = `http://127.0.0.1:${port}`;

  return {
    proc,
    port,
    dataDir,
    url,
    password: PASSWORD,
    stop() {
      try {
        proxyServer?.close();
      } catch {
        /* already closed */
      }
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    },
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function waitForHealth(url, timeoutMs, proc) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // A 200 proves only that SOMETHING serves this port; the server we spawned
    // must still be alive for that 200 to be ours. Without this check the loop
    // accepted a foreign listener's health response as a successful start.
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `the server process exited (code ${proc.exitCode}, signal ${proc.signalCode}) before becoming healthy`,
      );
    }
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Health check at ${url} timed out after ${timeoutMs}ms`);
}

// ── Port ownership ──────────────────────────────────────────────
//
// The harness must start its own server or fail. Adopting whatever answers on
// the port makes two runs share one server (and one database), and they then
// TRUNCATE each other's tables between scenarios — a false red that reads
// exactly like a product auth bug.

async function assertPortAvailable(port, role) {
  // Two probes, because either alone can be fooled: a listener bound with
  // SO_REUSEPORT still lets our bind succeed, and a bound-but-not-accepting
  // socket refuses our connect.
  if (await somethingIsListening(port)) throw portConflict(port, role);
  await assertBindable(port, role);
}

function somethingIsListening(port) {
  return new Promise((resolveProbe) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (answer) => {
      socket.destroy();
      resolveProbe(answer);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function assertBindable(port, role) {
  return new Promise((resolveProbe, rejectProbe) => {
    const probe = net.createServer();
    probe.once('error', (err) => {
      rejectProbe(
        err.code === 'EADDRINUSE' || err.code === 'EACCES' ? portConflict(port, role) : err,
      );
    });
    probe.listen({ port, host: '127.0.0.1' }, () => probe.close(() => resolveProbe()));
  });
}

function portConflict(port, role) {
  return new Error(
    `Port ${port} (${role}) is already in use by ${describePortHolder(port)}.\n` +
      `Refusing to adopt a server this harness did not start: sharing one means sharing one ` +
      `database, and the per-scenario TRUNCATE then wipes the other run's sessions ` +
      `("HTTP 401: session expired" in whichever run loses the race).\n` +
      `Look for another run (pgrep -af cross-platform-sync) and let it finish, or free the port. ` +
      `Each worktree allocates from its own slot band — see xplatSyncBand in scripts/lib/slot.mjs.`,
  );
}

function describePortHolder(port) {
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const holders = (lsof.stdout || '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
  return holders.length > 0 ? holders.join(' | ') : 'an unidentified process (lsof said nothing)';
}

// Belt to the pre-flight's braces: proves the healthy responder is the child we
// spawned rather than a stranger that won a race for the port. lsof silence is
// inconclusive (no lsof on PATH, or a listener owned by another user), so it
// does not fail the run on its own.
function assertListenerIsOurs(port, pid) {
  const lsof = spawnSync('lsof', ['-tnP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const pids = (lsof.stdout || '')
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (pids.length > 0 && !pids.includes(pid)) {
    throw new Error(
      `Port ${port} answered /health, but it is served by pid(s) ${pids.join(', ')} — not the ` +
        `server this harness started (pid ${pid}). Refusing to run against a foreign server.`,
    );
  }
}

// ── Database ownership ──────────────────────────────────────────

// Per-worktree database, exactly like scripts/qa.mjs's per-slot sync server:
// the reset above TRUNCATEs, so a shared database is a shared destructive
// surface even when the ports are isolated.
function databaseUrl(repoRoot) {
  return (
    process.env.FUTO_NOTES_E2EE_DATABASE_URL || `${PG_BASE}/futo_notes_xplat_s${slotOf(repoRoot)}`
  );
}

function ensureDatabase(serverRepo, dbUrl) {
  if (readyDatabases.has(dbUrl)) return;
  const database = dbUrl.slice(dbUrl.lastIndexOf('/') + 1);
  const create = pgQuery(serverRepo, `${PG_BASE}/postgres`, `CREATE DATABASE ${database}`);
  if (create.status !== 0 && !/already exists|42P04/.test(create.stderr || '')) {
    throw new Error(
      `Failed to create the harness database ${database}:\n${create.stderr || create.stdout}`,
    );
  }
  // The server runs migrateToLatest() on boot, so no separate migrate step.
  readyDatabases.add(dbUrl);
}

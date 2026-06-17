/**
 * Sync test server launcher.
 *
 * Starts the E2EE futo-notes-server process with isolated blob storage.
 * Used by cross-platform sync tests to get a fresh server per scenario.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { Readable } from 'node:stream';

const PASSWORD = 'testing123';

const hashCache = new Map();

function hashPassword(serverRepo, password) {
  const cacheKey = `${serverRepo}\0${password}`;
  const cached = hashCache.get(cacheKey);
  if (cached) return cached;
  const result = spawnSync('pnpm', ['exec', 'tsx', 'src/index.ts', 'hash', password], {
    cwd: serverRepo,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Failed to hash test server password:\n${result.stderr || result.stdout}`);
  }
  const hash = result.stdout.trim();
  hashCache.set(cacheKey, hash);
  return hash;
}

/**
 * Start a fresh sync server on the given port.
 *
 * @param {number} port
 * @param {string} repoRoot — client monorepo root
 * @param {{ syncDelayMs?: number }} [options]
 * @returns {Promise<{proc, port, dataDir, url, password, stop}>}
 */
export async function startServer(port, repoRoot, options = {}) {
  const syncDelayMs = options.syncDelayMs ?? 0;
  const dataDir = mkdtempSync(join(tmpdir(), 'sf-test-server-'));
  const blobDir = join(dataDir, 'blobs');
  // When a delay proxy is requested, the real server moves to port + 1500 and
  // the proxy takes `port`. NOT +1000: with the suite's base port 4000 that
  // lands on 5000, which macOS ControlCenter (AirPlay Receiver) holds —
  // EADDRINUSE on any solo run of a delayed scenario. 5500+ is clear of
  // AirPlay's 5000/7000.
  const serverPort = syncDelayMs > 0 ? port + 1500 : port;
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
  if (!externalDb) {
    const compose = spawnSync('docker', ['compose', 'up', '-d', 'postgres'], {
      cwd: serverRepo,
      encoding: 'utf8',
    });
    if (compose.status !== 0) {
      throw new Error(`Failed to start E2EE server Postgres:\n${compose.stderr || compose.stdout}`);
    }
  }

  const passwordHash = hashPassword(serverRepo, PASSWORD);

  const env = {
    ...process.env,
    PORT: String(serverPort),
    BLOB_DIR: blobDir,
    DATABASE_URL: process.env.FUTO_NOTES_E2EE_DATABASE_URL
      || 'postgres://futo_notes:futo_notes@localhost:5433/futo_notes',
    AUTH_MODE: 'password',
    FUTO_NOTES_PASSWORD_HASH: passwordHash,
  };

  const proc = spawn('pnpm', ['start'], {
    cwd: serverRepo,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Collect stderr for diagnostics on failure
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  // Wait for the server to be healthy
  const upstreamUrl = `http://127.0.0.1:${serverPort}`;
  await waitForHealth(`${upstreamUrl}/health`, 30_000).catch((err) => {
    proc.kill('SIGKILL');
    throw new Error(
      `E2EE server failed to start on port ${serverPort}: ${err.message}\nstdout: ${stdout.slice(-500)}\nstderr: ${stderr.slice(-500)}`,
    );
  });

  const truncateSql = 'TRUNCATE orphaned_blobs, objects, collections, sessions, users CASCADE;';
  const reset = externalDb
    ? spawnSync('psql', [process.env.FUTO_NOTES_E2EE_DATABASE_URL, '-c', truncateSql], {
        encoding: 'utf8',
      })
    : spawnSync('docker', [
        'compose', 'exec', '-T', 'postgres', 'psql',
        '-U', 'futo_notes', '-d', 'futo_notes', '-c', truncateSql,
      ], { cwd: serverRepo, encoding: 'utf8' });
  if (reset.status !== 0) {
    proc.kill('SIGKILL');
    throw new Error(`Failed to reset E2EE server database:\n${reset.stderr || reset.stdout}`);
  }

  let proxyServer = null;
  if (syncDelayMs > 0) {
    proxyServer = http.createServer(async (req, res) => {
      try {
        const targetUrl = new URL(req.url ?? '/', upstreamUrl);
        const body = await readRequestBody(req);

        if (
          syncDelayMs > 0
          && targetUrl.pathname.includes('/objects')
          && ['GET', 'POST', 'PUT', 'DELETE'].includes(req.method ?? '')
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
          upstreamStream.on('error', () => { if (!res.writableEnded) res.end(); });
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
      try { proxyServer?.close(); } catch { /* already closed */ }
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
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

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Health check at ${url} timed out after ${timeoutMs}ms`);
}

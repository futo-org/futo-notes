/**
 * Sync test server launcher.
 *
 * Starts the E2EE stonefruit-server process with isolated blob storage.
 * Used by cross-platform sync tests to get a fresh server per scenario.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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
  const serverPort = syncDelayMs > 0 ? port + 1000 : port;
  const serverRepo = resolve(
    process.env.STONEFRUIT_E2EE_SERVER_REPO || '/home/justin/Developer/stonefruit-server',
  );

  if (!existsSync(join(serverRepo, 'package.json'))) {
    throw new Error(
      `E2EE server repo not found at ${serverRepo}. Set STONEFRUIT_E2EE_SERVER_REPO to the stonefruit-server checkout.`,
    );
  }

  // If the caller provides a DATABASE_URL (e.g. CI with a services: postgres
  // sidecar), trust it and skip docker compose — the dind runner can't reach
  // a host-level compose container at localhost:5433 anyway.
  const externalDb = !!process.env.STONEFRUIT_E2EE_DATABASE_URL;
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
    DATABASE_URL: process.env.STONEFRUIT_E2EE_DATABASE_URL
      || 'postgres://stonefruit:stonefruit@localhost:5433/stonefruit',
    AUTH_MODE: 'password',
    STONEFRUIT_PASSWORD_HASH: passwordHash,
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
    ? spawnSync('psql', [process.env.STONEFRUIT_E2EE_DATABASE_URL, '-c', truncateSql], {
        encoding: 'utf8',
      })
    : spawnSync('docker', [
        'compose', 'exec', '-T', 'postgres', 'psql',
        '-U', 'stonefruit', '-d', 'stonefruit', '-c', truncateSql,
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
        const responseBody = Buffer.from(await upstream.arrayBuffer());
        res.end(responseBody);
      } catch (err) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`Proxy error: ${err instanceof Error ? err.message : String(err)}`);
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

/**
 * Sync test server launcher.
 *
 * Starts a stonefruit-server process with an isolated temp data directory.
 * Used by cross-platform sync tests to get a fresh server per scenario.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, accessSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PASSWORD = 'testing123';

/**
 * Start a fresh sync server on the given port.
 *
 * @param {number} port
 * @param {string} repoRoot — monorepo root for locating the binary
 * @param {{ syncDelayMs?: number }} [options]
 * @returns {Promise<{proc, port, dataDir, url, password, stop}>}
 */
export async function startServer(port, repoRoot, options = {}) {
  const syncDelayMs = options.syncDelayMs ?? 0;
  const dataDir = mkdtempSync(join(tmpdir(), 'sf-test-server-'));
  const serverPort = syncDelayMs > 0 ? port + 1000 : port;

  const env = {
    ...process.env,
    PORT: String(serverPort),
    DATA_DIR: dataDir,
    STONEFRUIT_DEV_PASSWORD: PASSWORD,
  };

  // Try pre-built binary first, fall back to cargo run
  const binaryPath = join(repoRoot, 'target', 'debug', 'stonefruit-server');
  let proc;
  try {
    accessSync(binaryPath);
    proc = spawn(binaryPath, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    proc = spawn('cargo', ['run', '-p', 'stonefruit-server'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  // Collect stderr for diagnostics on failure
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  // Wait for the server to be healthy
  const upstreamUrl = `http://127.0.0.1:${serverPort}`;
  await waitForHealth(`${upstreamUrl}/health`, 30_000).catch((err) => {
    proc.kill('SIGKILL');
    throw new Error(`Server failed to start on port ${serverPort}: ${err.message}\nstderr: ${stderr.slice(-500)}`);
  });

  let proxyServer = null;
  if (syncDelayMs > 0) {
    proxyServer = http.createServer(async (req, res) => {
      try {
        const targetUrl = new URL(req.url ?? '/', upstreamUrl);
        const body = await readRequestBody(req);

        if (req.method === 'POST' && targetUrl.pathname === '/sync') {
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

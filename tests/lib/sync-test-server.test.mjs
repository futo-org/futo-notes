// Port ownership for the cross-platform sync harness.
//
// The bug these pin: startServer's health check was satisfied by ANY listener on
// the port, so a second worktree adopted the first's server, shared its
// database, and TRUNCATEd its sessions between scenarios — surfacing as
// "HTTP 401: session expired" in a run that had done nothing wrong.
import http from 'node:http';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startServer } from './sync-test-server.mjs';
import { XPLAT_SYNC_BAND } from '../../scripts/lib/slot.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const closers = [];

/** A port well outside every slot band, so these tests never touch a real run. */
const PROBE_PORT = XPLAT_SYNC_BAND.base - 7;

afterEach(async () => {
  while (closers.length) await closers.pop()();
});

function listenHealthy(port) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  closers.push(() => new Promise((done) => server.close(done)));
  return new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ready(server));
  });
}

function listenSilent(port) {
  const server = net.createServer(() => {});
  closers.push(() => new Promise((done) => server.close(done)));
  return new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ready(server));
  });
}

describe('startServer port ownership', () => {
  it('refuses a port a foreign server already answers /health on', async () => {
    await listenHealthy(PROBE_PORT);
    // Would resolve happily before the fix: the foreign 200 was the whole check.
    await expect(startServer(PROBE_PORT, REPO_ROOT)).rejects.toThrow(
      new RegExp(`Port ${PROBE_PORT} \\(sync server\\) is already in use`),
    );
  });

  it('names the conflict and how to resolve it', async () => {
    await listenHealthy(PROBE_PORT);
    const error = await startServer(PROBE_PORT, REPO_ROOT).catch((err) => err);
    expect(error.message).toMatch(/Refusing to adopt a server this harness did not start/);
    expect(error.message).toMatch(/HTTP 401: session expired/);
    expect(error.message).toMatch(/pgrep -af cross-platform-sync/);
  });

  it('refuses a bound port even when nothing answers', async () => {
    await listenSilent(PROBE_PORT);
    await expect(startServer(PROBE_PORT, REPO_ROOT)).rejects.toThrow(/already in use/);
  });

  it('checks both halves of the pair a delayed scenario needs', async () => {
    // With a delay proxy the proxy takes `port` and the server moves one up, so
    // a conflict on the proxy half must be refused just as loudly.
    await listenHealthy(PROBE_PORT);
    await expect(startServer(PROBE_PORT, REPO_ROOT, { syncDelayMs: 100 })).rejects.toThrow(
      new RegExp(`Port ${PROBE_PORT} \\(sync delay proxy\\) is already in use`),
    );
  });
});

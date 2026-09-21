// `just coin-tuner` — serve the coin tuner.
//
// A plain static server rather than Vite, because the page needs nothing built:
// it imports three.js straight out of node_modules through an import map, loads
// the real `futo-coin.glb`, and rebuilds the studio in the browser from
// `scripts/lib/studio-env.mjs` — the same arithmetic `build-coin.py` uses, held
// to it by `just coin-check`.
//
// The port is slot-derived, so two worktrees can each have a tuner up without
// one serving the other's coin.

import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { portsFor } from './lib/slot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/// Exactly what the page needs, and nothing else. This serves out of a source
/// checkout on a listening socket, so it is an allowlist rather than a document
/// root with a traversal guard bolted on.
const SERVABLE = [
  'scripts/coin-tuner/',
  'scripts/lib/studio-env.mjs',
  'assets/coin/futo-coin.glb',
  'assets/coin/studio-env.hdr',
  'node_modules/three/build/',
  'node_modules/three/examples/jsm/',
  'node_modules/three/src/',
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.hdr': 'image/vnd.radiance',
};

function resolveRequest(url) {
  const pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  const relative = (pathname === '/' ? 'scripts/coin-tuner/index.html' : pathname).replace(
    /^\/+/,
    '',
  );
  const absolute = path.resolve(ROOT, relative);
  // `path.resolve` has already flattened any `..`, so this compares the real
  // target rather than the string the client sent.
  const inside = path.relative(ROOT, absolute);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
  const posix = inside.split(path.sep).join('/');
  if (!SERVABLE.some((prefix) => posix === prefix || posix.startsWith(prefix))) return null;
  return absolute;
}

const server = http.createServer((request, response) => {
  const file = request.url === undefined ? null : resolveRequest(request.url);
  if (file === null) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not served by the coin tuner\n');
    return;
  }
  let size;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) throw new Error('not a file');
    size = stats.size;
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end(`no such file: ${request.url}\n`);
    return;
  }
  response.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'content-length': size,
    // Everything here is read off disk on each request; a cached module is how
    // you edit tuner.js and wonder why nothing changed.
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(response);
});

const port = portsFor(ROOT).coinTuner;
server.listen(port, '127.0.0.1', () => {
  console.log(`Coin tuner:  http://127.0.0.1:${port}/`);
  console.log('Ctrl-C to stop.');
});

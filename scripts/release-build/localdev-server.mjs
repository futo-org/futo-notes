// The localhost updater server release-build.mjs uses to host a localdev build (`build --serve`, `e2e`).
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { DEFAULT_PORT, log } from './profiles.mjs';

export function serveDir(dir, port) {
  const types = {
    '.json': 'application/json',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.AppImage': 'application/octet-stream',
    '.exe': 'application/octet-stream',
  };
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = resolve(root, urlPath.replace(/^\/+/, ''));
    const within = file === root || file.startsWith(root + sep);
    if (!within || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
      log(`404 ${urlPath}`);
      return;
    }
    const ext = Object.keys(types).find((e) => file.endsWith(e));
    res.writeHead(200, {
      'content-type': ext ? types[ext] : 'application/octet-stream',
      'content-length': statSync(file).size,
    });
    log(`200 ${urlPath}`);
    createReadStream(file).pipe(res);
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      log(`ERROR: port ${port} is already in use.`);
      log('  Another worktree is probably serving its localdev update on this');
      log('  port. The localdev app config pins this endpoint, so it cannot be');
      log('  slot-derived — stop that server (Ctrl-C) and re-run.');
    } else {
      log(`ERROR: cannot serve ${dir} on port ${port}: ${error.message}`);
    }
    process.exit(1);
  });
  server.listen(port, 'localhost', () =>
    log(`serving ${dir} at http://localhost:${port} (manifest: /latest.json)`),
  );
  return server;
}

export function serveLocaldev(out) {
  const port = DEFAULT_PORT;
  log(`Serving the update now (Ctrl-C to stop):`);
  serveDir(out, port);
}

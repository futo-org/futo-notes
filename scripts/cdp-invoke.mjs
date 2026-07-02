#!/usr/bin/env node
// Tiny CDP client: connect to a remote Android webview's DevTools socket and
// run an expression via Runtime.evaluate (which bypasses page CSP). Prints the
// remote result as JSON.
//
// Usage:
//   node scripts/cdp-invoke.mjs "window.FutoEditor.getContent()"
//   node scripts/cdp-invoke.mjs --port 9331 "expr"
//
// The port defaults to $CDP_PORT (exported by `just cdp-forward`, which
// forwards to a per-worktree port so parallel sessions don't steal each
// other's forward), then 9228.

import WebSocket from 'ws';

const args = process.argv.slice(2);
let port = Number(process.env.CDP_PORT || 9228);
const out = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') {
    port = Number(args[++i]);
  } else {
    out.push(args[i]);
  }
}
const expr = out.join(' ');
if (!expr) {
  console.error('usage: cdp-invoke.mjs [--port 9228] "<js expression>"');
  process.exit(2);
}

const pages = await fetch(`http://localhost:${port}/json`).then((r) => r.json());
const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
if (!page) {
  console.error('no debuggable page at localhost:' + port);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

ws.on('open', async () => {
  try {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      // 120s is generous — first-run embed includes a ~35MB download.
      timeout: 120000,
    });
    if (r.exceptionDetails) {
      console.error(JSON.stringify(r.exceptionDetails, null, 2));
      process.exit(3);
    }
    console.log(JSON.stringify(r.result.value ?? r.result, null, 2));
    ws.close();
    process.exit(0);
  } catch (e) {
    console.error('CDP error:', e.message || e);
    process.exit(4);
  }
});

ws.on('error', (e) => {
  console.error('ws error:', e.message);
  process.exit(5);
});

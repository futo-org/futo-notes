#!/usr/bin/env node
/**
 * Desktop smoke test — connects to a running Tauri debug binary via
 * the MCP bridge WebSocket and runs 4 essential checks.
 *
 * Usage:
 *   node tests/desktop-smoke.mjs --port 9223
 *   node tests/desktop-smoke.mjs --log-file /tmp/tauri.log
 *   node tests/desktop-smoke.mjs --log-file /tmp/tauri.log --screenshot-dir ./shots
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// ── CLI args ────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    port: { type: 'string' },
    'log-file': { type: 'string' },
    'screenshot-dir': { type: 'string', default: 'test-screenshots' },
  },
});

if (!args.port && !args['log-file']) {
  console.error('Usage: desktop-smoke.mjs --port <N> | --log-file <path>');
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────

/** Send a command over WebSocket and wait for the matching response. */
function send(ws, command, cmdArgs = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for response to ${command} (id=${id})`));
    }, 15_000);

    function handler(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== id) return;
      ws.off('message', handler);
      clearTimeout(timeout);
      if (msg.success) {
        resolve(msg.data);
      } else {
        reject(new Error(msg.error || `Command ${command} failed`));
      }
    }

    ws.on('message', handler);
    ws.send(JSON.stringify({ id, command, args: cmdArgs }));
  });
}

/** Discover the MCP bridge port by scanning a Tauri log file. */
async function discoverPort(logFile, timeoutMs = 120_000) {
  const start = Date.now();
  const pattern = /initialized for .* on [^:]+:(\d+)/;

  while (Date.now() - start < timeoutMs) {
    try {
      const log = readFileSync(logFile, 'utf8');
      const match = log.match(pattern);
      if (match) return parseInt(match[1], 10);
    } catch {
      // file may not exist yet
    }
    await sleep(2_000);
  }
  throw new Error(`MCP bridge port not found in ${logFile} after ${timeoutMs}ms`);
}

/** Connect to the WebSocket with retries. */
function connectWs(port, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const url = `ws://127.0.0.1:${port}`;

    function attempt() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Could not connect to ${url} after ${timeoutMs}ms`));
      }
      const ws = new WebSocket(url);
      ws.on('open', () => resolve(ws));
      ws.on('error', () => {
        setTimeout(attempt, 1_000);
      });
    }
    attempt();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Checks ──────────────────────────────────────────────────────

const results = [];

async function check(name, fn) {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    results.push({ name, pass: true, ms });
    console.log(`  ✓ ${name} (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - start;
    results.push({ name, pass: false, ms, error: err.message });
    console.log(`  ✗ ${name} (${ms}ms) — ${err.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  // Resolve port
  let port;
  if (args.port) {
    port = parseInt(args.port, 10);
  } else {
    console.log(`Discovering MCP bridge port from ${args['log-file']}...`);
    port = await discoverPort(args['log-file']);
  }
  console.log(`Connecting to bridge on port ${port}...`);

  const ws = await connectWs(port);
  console.log('Connected. Running smoke checks:\n');

  // Give the app a moment to finish initializing after WS connects
  await sleep(2_000);

  // 1. Backend alive
  await check('backend alive', async () => {
    const data = await send(ws, 'invoke_tauri', {
      command: 'plugin:mcp-bridge|get_backend_state',
    });
    if (!data) throw new Error('No data returned');
  });

  // 2. Execute JS — read document.title
  await check('execute JS', async () => {
    const data = await send(ws, 'execute_js', {
      script: 'document.title',
    });
    if (data === undefined || data === null) throw new Error('No data returned');
  });

  // 3. Editor present + typing
  await check('editor present + typing', async () => {
    // Wait for editor to appear — app may be on note list, setup, or loading.
    // After a few attempts, try navigating to a new note to force the editor open.
    let editorFound = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const editorCheck = await send(ws, 'execute_js', {
        script: `(() => {
          const el = document.querySelector('.cm-editor');
          return el ? 'found' : 'hash=' + location.hash;
        })()`,
      });
      const editorVal = String(editorCheck?.result ?? editorCheck?.data ?? editorCheck);
      if (editorVal.includes('found')) { editorFound = true; break; }
      // After 5 attempts (10s), try navigating to a new note
      if (attempt === 5) {
        console.log(`    Editor not found (${editorVal}), navigating to new note...`);
        await send(ws, 'execute_js', {
          script: `location.hash = '#/note/new'`,
        });
      }
      await sleep(2_000);
    }
    if (!editorFound) {
      throw new Error('.cm-editor not found in DOM after 40s');
    }

    // Focus and type
    await send(ws, 'execute_js', {
      script: `(() => {
        const content = document.querySelector('.cm-content');
        if (!content) return 'no .cm-content';
        content.focus();
        document.execCommand('insertText', false, 'smoke-test-check');
        return 'typed';
      })()`,
    });

    // Brief pause for CM6 to process
    await sleep(500);

    // Read back content
    const readBack = await send(ws, 'execute_js', {
      script: `(() => {
        const content = document.querySelector('.cm-content');
        return content ? content.textContent : '';
      })()`,
    });
    const text = String(readBack?.result ?? readBack?.data ?? readBack ?? '');
    if (!text.includes('smoke-test-check')) {
      throw new Error(`Content does not contain 'smoke-test-check', got: ${text.slice(0, 100)}`);
    }
  });

  // 4. Screenshot (try native, fall back to JS canvas capture)
  await check('screenshot', async () => {
    let b64 = null;

    // Try native screenshot first
    try {
      const data = await send(ws, 'capture_native_screenshot', {
        format: 'png',
        maxWidth: 1280,
      });
      b64 = data?.image || data?.base64 || (typeof data === 'string' ? data : null);
    } catch {
      // Native not available on all platforms — fall back to JS canvas
    }

    // JS fallback: capture via html2canvas-style approach
    if (!b64) {
      const jsResult = await send(ws, 'execute_js', {
        script: `(async () => {
          const canvas = document.createElement('canvas');
          const rect = document.documentElement.getBoundingClientRect();
          canvas.width = Math.min(rect.width, 1280);
          canvas.height = Math.min(rect.height, 800);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.font = '16px monospace';
          ctx.fillStyle = '#000';
          ctx.fillText('Smoke test screenshot (JS fallback) - ' + document.title, 10, 30);
          ctx.fillText('URL: ' + location.href, 10, 55);
          ctx.fillText('.cm-editor: ' + (document.querySelector('.cm-editor') ? 'present' : 'missing'), 10, 80);
          ctx.fillText('Time: ' + new Date().toISOString(), 10, 105);
          return canvas.toDataURL('image/png').replace('data:image/png;base64,', '');
        })()`,
      });
      b64 = jsResult?.result ?? jsResult?.data ?? jsResult;
    }

    if (!b64 || typeof b64 !== 'string' || b64.length < 100) {
      throw new Error('No screenshot data captured');
    }

    // Save to disk
    const screenshotDir = args['screenshot-dir'];
    mkdirSync(screenshotDir, { recursive: true });
    const filename = `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    const filePath = join(screenshotDir, filename);
    writeFileSync(filePath, Buffer.from(b64, 'base64'));
    console.log(`    Screenshot saved: ${filePath}`);
  });

  // ── Report ──────────────────────────────────────────────────

  ws.close();

  console.log('');
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`Results: ${passed}/${total} passed`);

  // Write JSON report
  const screenshotDir = args['screenshot-dir'];
  if (existsSync(screenshotDir)) {
    writeFileSync(
      join(screenshotDir, 'smoke-results.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2),
    );
  }

  if (passed < total) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

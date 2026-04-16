/**
 * Shared MCP bridge WebSocket client.
 *
 * Extracted from desktop-smoke.mjs so both the smoke test and
 * cross-platform sync tests can reuse the same protocol helpers.
 */

import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Send a command over WebSocket and wait for the matching response. */
export function send(ws, command, cmdArgs = {}, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for response to ${command} (id=${id})`));
    }, timeoutMs);

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
export async function discoverPort(logFile, timeoutMs = 120_000) {
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
export function connectWs(port, timeoutMs = 30_000) {
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

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Execute JavaScript in the Tauri webview and return the result.
 * Unwraps the nested result/data wrapper that execute_js sometimes returns.
 */
export async function executeJs(ws, script, opts = {}) {
  const data = await send(ws, 'execute_js', { script }, opts);
  return data?.result ?? data?.data ?? data;
}

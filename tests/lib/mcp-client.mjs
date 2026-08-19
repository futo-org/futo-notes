/**
 * Shared MCP bridge WebSocket client.
 *
 * Extracted from desktop-smoke.mjs so both the smoke test and
 * cross-platform sync tests can reuse the same protocol helpers.
 */

import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

/** Who is LISTENING on this port? Best-effort, for error messages only. */
export function describePortHolder(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = out.trim().split('\n').slice(1);
    if (lines.length === 0) return 'nothing is listening on it';
    const holders = [
      ...new Set(
        lines.map((line) => {
          const [command, pid, , , , , , , name] = line.split(/\s+/);
          return `${command} (pid ${pid})${name ? ` on ${name}` : ''}`;
        }),
      ),
    ];
    return `held by ${holders.join(', ')}`;
  } catch {
    return 'could not determine the port holder (lsof unavailable)';
  }
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
    // Poll on the condition's own scale, not a 2s tick: this delay lands
    // directly in launch-to-interaction measurements and quantized them into
    // 2s buckets long after the bridge was actually up (M15, pc_1b43f3c216c0).
    await sleep(100);
  }
  throw new Error(`MCP bridge port not found in ${logFile} after ${timeoutMs}ms`);
}

/** Connect to the WebSocket with retries. */
export function connectWs(port, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const url = `ws://127.0.0.1:${port}`;
    let done = false;
    let pending = null;

    // A hard deadline, not just a check on each retry. A squatter that ACCEPTS
    // the TCP connection but never completes the WebSocket upgrade (any plain
    // TCP listener does this) fires neither 'open' nor 'error', so the
    // retry-time check below was never reached and this promise hung forever
    // instead of timing out. Same failure shape as a harness that looks stuck
    // rather than blocked.
    const deadline = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        pending?.terminate();
      } catch {
        // already gone
      }
      reject(
        new Error(
          `Could not connect to ${url} after ${timeoutMs}ms — port ${port} is ` +
            `${describePortHolder(port)}. If that is not the FUTO Notes dev app, ` +
            `something else is on this worktree's bridge port.`,
        ),
      );
    }, timeoutMs);

    const settle = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      fn(value);
    };

    function attempt() {
      if (done) return;
      if (Date.now() - start > timeoutMs) {
        // Name the port holder. The bridge used to bind 0.0.0.0 while every
        // client dials 127.0.0.1, so an unrelated loopback listener (a
        // browser's remote-debugging socket) silently won this port and the
        // bare "could not connect" read as a broken app. The app now binds
        // loopback so that cannot alias any more, but a squatter can still
        // occupy the port outright — so say who it is (pc_8928c073b738).
        return settle(
          reject,
          new Error(
            `Could not connect to ${url} after ${timeoutMs}ms — port ${port} is ` +
              `${describePortHolder(port)}. If that is not the FUTO Notes dev app, ` +
              `something else is on this worktree's bridge port.`,
          ),
        );
      }
      const ws = new WebSocket(url);
      pending = ws;
      ws.on('open', () => settle(resolve, ws));
      ws.on('error', () => {
        if (done) return;
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

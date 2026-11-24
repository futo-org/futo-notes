#!/usr/bin/env node
/**
 * Desktop smoke test — connects to a running Tauri debug binary via
 * the MCP bridge WebSocket and runs the essential checks, including that a
 * typed note is saved to the vault on disk (`--notes-dir` is the app's
 * isolated vault, never a real one).
 *
 * Usage:
 *   node tests/desktop-smoke.mjs --port 9223 --notes-dir /tmp/vault
 *   node tests/desktop-smoke.mjs --log-file /tmp/tauri.log --notes-dir /tmp/vault
 *   node tests/desktop-smoke.mjs --log-file /tmp/tauri.log --notes-dir /tmp/vault --screenshot-dir ./shots
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { send, discoverPort, connectWs, sleep } from './lib/mcp-client.mjs';

// ── CLI args ────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    port: { type: 'string' },
    'log-file': { type: 'string' },
    'notes-dir': { type: 'string' },
    'screenshot-dir': { type: 'string', default: 'test-screenshots' },
  },
});

if ((!args.port && !args['log-file']) || !args['notes-dir']) {
  console.error('Usage: desktop-smoke.mjs (--port <N> | --log-file <path>) --notes-dir <vault>');
  process.exit(1);
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

// ── Vault on disk ───────────────────────────────────────────────

const SAVE_TIMEOUT_MS = 10_000;

/** Every `.md` in the vault (outside dot-directories) with its current bytes. */
function readVaultNotes(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((rel) => rel.endsWith('.md') && !rel.split(/[\\/]/).some((p) => p.startsWith('.')))
    .flatMap((rel) => {
      try {
        const path = join(dir, rel);
        return [{ rel, size: statSync(path).size, text: readFileSync(path, 'utf8') }];
      } catch {
        return []; // renamed or replaced between the listing and the read
      }
    });
}

/**
 * Poll until `done(notes)` holds, failing at once if a note on disk is empty:
 * a save must never pass through an empty file. `savedBefore` skips that guard
 * until the first save has landed (a new note starts with nothing to save).
 */
async function waitForDisk(dir, what, done, { savedBefore = true } = {}) {
  const deadline = Date.now() + SAVE_TIMEOUT_MS;
  let notes = [];
  while (Date.now() < deadline) {
    notes = readVaultNotes(dir);
    const empty = notes.find((n) => n.size === 0);
    if (savedBefore && empty) throw new Error(`${empty.rel} was left empty on disk`);
    if (done(notes)) return;
    await sleep(100);
  }
  const seen = notes.map((n) => `${n.rel} (${n.size}B)`).join(', ') || 'no notes';
  throw new Error(`${what} not on disk in ${dir} after ${SAVE_TIMEOUT_MS / 1000}s; found ${seen}`);
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
    // Navigate to a new note — the editor only mounts when a note is open
    await send(ws, 'execute_js', {
      script: `window.location.hash = '#/note/new'`,
    });
    await sleep(1_000);

    // `.desktop-editor` is the contenteditable the desktop editor mounts
    // (src/features/editor/desktop/view.ts).
    let editorFound = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      const editorCheck = await send(ws, 'execute_js', {
        script: `(() => {
          const el = document.querySelector('.desktop-editor');
          return el ? 'found' : 'missing';
        })()`,
      });
      const editorVal = String(editorCheck?.result ?? editorCheck?.data ?? editorCheck);
      if (editorVal.includes('found')) {
        editorFound = true;
        break;
      }
      await sleep(2_000);
    }
    if (!editorFound) {
      throw new Error('.desktop-editor not found in DOM after 30s');
    }

    // Focus and type: `.desktop-editor` is itself the contenteditable root.
    await send(ws, 'execute_js', {
      script: `(() => {
        const content = document.querySelector('.desktop-editor');
        if (!content) return 'no .desktop-editor';
        content.focus();
        document.execCommand('insertText', false, 'smoke-test-check');
        return 'typed';
      })()`,
    });

    // Brief pause for the editor to draw
    await sleep(500);

    // Read back content
    const readBack = await send(ws, 'execute_js', {
      script: `(() => {
        const content = document.querySelector('.desktop-editor');
        return content ? content.textContent : '';
      })()`,
    });
    const text = String(readBack?.result ?? readBack?.data ?? readBack ?? '');
    if (!text.includes('smoke-test-check')) {
      throw new Error(`Content does not contain 'smoke-test-check', got: ${text.slice(0, 100)}`);
    }
  });

  // 4. The typed note reaches the host and is written to the vault. The editor
  // showing the text proves nothing about a save; the file on disk does.
  const notesDir = args['notes-dir'];
  let savedRel;
  await check('typed note saved to disk', async () => {
    await waitForDisk(
      notesDir,
      "'smoke-test-check'",
      (notes) => {
        savedRel = notes.find((n) => n.text.includes('smoke-test-check'))?.rel;
        return savedRel !== undefined;
      },
      { savedBefore: false },
    );
  });

  // 5. A second edit replaces the body: that same file follows it, and no file
  // is left empty on the way. Skipped, without touching the editor, unless the
  // first save landed in `--notes-dir`: that is what proves the app under test
  // is the isolated one, so the select-all below can never hit another vault.
  await check('edited note saved to disk', async () => {
    if (!savedRel) throw new Error('skipped: the first edit never reached --notes-dir');
    await send(ws, 'execute_js', {
      script: `(() => {
        const content = document.querySelector('.desktop-editor');
        if (!content) return 'no .desktop-editor';
        content.focus();
        document.execCommand('selectAll');
        document.execCommand('insertText', false, 'smoke-test-edited');
        return 'typed';
      })()`,
    });
    await waitForDisk(notesDir, `'smoke-test-edited' in ${savedRel}`, (notes) => {
      const text = notes.find((n) => n.rel === savedRel)?.text;
      return text?.includes('smoke-test-edited') && !text.includes('smoke-test-check');
    });
  });

  // 6. Screenshot of the real window, kept as a CI artifact. Best-effort, not a
  // check: the tag job blocks the release and native capture is not proven on
  // every runner (e.g. without Screen Recording permission), so an unavailable
  // capture is reported, never replaced by a placeholder image.
  try {
    const data = await send(ws, 'capture_native_screenshot', { format: 'png', maxWidth: 1280 });
    const b64 = data?.image || data?.base64 || (typeof data === 'string' ? data : null);
    if (!b64 || b64.length < 100) throw new Error('empty capture');
    const screenshotDir = args['screenshot-dir'];
    mkdirSync(screenshotDir, { recursive: true });
    const filename = `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    const filePath = join(screenshotDir, filename);
    writeFileSync(filePath, Buffer.from(b64, 'base64'));
    console.log(`  Screenshot saved: ${filePath}`);
  } catch (err) {
    console.log(`  Screenshot unavailable (native capture failed: ${err.message}) — no artifact`);
  }

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

// Plain Markdown copy, cut and paste through compiled WASM and the real store.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { savedSource } from '../wasm-saved-source.mjs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);

const vault = mkdtempSync(join(tmpdir(), 'futo-editor-wasm-clipboard-'));
let session;
let worker;
let exited;
let deadline;
const start = async (fixture) => {
  worker = spawn(process.argv[3], [vault, fixture], { stdio: ['pipe', 'pipe', 'inherit'] });
  exited = once(worker, 'exit');
  deadline = setTimeout(() => worker.kill(), 30_000);
  deadline.unref();
  const lines = createInterface({ input: worker.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value);
  };
  session = WasmSession.restore(JSON.stringify(await next()));
  return async (request) => {
    worker.stdin.write(request + '\n');
    return next();
  };
};
const stop = async () => {
  clearTimeout(deadline);
  session?.free();
  session = undefined;
  worker.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0);
};
try {
  const exchange = await start('ab **cd**\r\nend');
  let display = 'ab cd\r\nend';
  const accept = async (applied) => {
    const { change, request } = JSON.parse(applied);
    const ack = await exchange(JSON.stringify(request));
    session.acknowledge(JSON.stringify(ack));
    const bytes = Buffer.from(display);
    display = Buffer.concat([
      bytes.subarray(0, change.range.start),
      Buffer.from(change.inserted),
      bytes.subarray(change.range.end),
    ]).toString();
  };
  assert.equal(session.copy_markdown(0n, 4, 5), '**d**');
  const request = session.paste_markdown(0n, 1, 1, 'x \t\n# T\ny');
  // Copy does not wait for the acknowledgement.
  assert.equal(session.copy_markdown(1n, 0, 1), 'a');
  await accept(request);
  const pasted = 'ax \t\r\n# T\r\nyb **cd**\r\nend';
  assert.equal(session.draft_text(), pasted);
  assert.equal(display, 'ax \t\r\nT\r\nyb cd\r\nend');
  const [markdown, cut] = JSON.parse(session.cut_markdown(1n, 12, 14));
  assert.equal(markdown, '**cd**');
  await accept(JSON.stringify(cut));
  const finalSource = 'ax \t\r\n# T\r\nyb \r\nend';
  assert.equal(session.draft_text(), finalSource);
  await accept(session.undo(2n));
  assert.equal(session.draft_text(), pasted);
  await accept(session.redo(3n));
  await stop();
  const reopened = await start('--reopen');
  assert.equal(session.draft_text(), savedSource(finalSource));
  assert.equal(JSON.parse(session.project(0n, 0, Buffer.byteLength(display))).text, display);
  assert.deepEqual(await reopened(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();
  console.log(
    'Compiled WASM clipboard: copy, one-action cut, Markdown paste and real store saving passed.',
  );
} finally {
  if (session) await stop();
  rmSync(vault, { recursive: true });
}

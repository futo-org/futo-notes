// Explicit merge flush adoption through compiled WASM and the public store host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout, clearTimeout } from 'node:timers';

export async function runMergeRegressions(WasmSession, executable) {
  await runMergeCase(WasmSession, executable, {
    base: 'first\n\nsecond\n',
    start: 7,
    end: 13,
    local: 'first\n\nLOCAL\n',
    remote: '日本🦀\n\nsecond\n',
    merged: '日本🦀\n\nLOCAL\n',
    selection: 17,
  });
  await runMergeCase(WasmSession, executable, {
    base: 'first middle last\r\n',
    start: 13,
    end: 17,
    local: 'first middle LOCAL\r\n',
    remote: '日本🦀 middle last\r\n',
    merged: '日本🦀 middle LOCAL\r\n',
    selection: 23,
  });
}

async function runMergeCase(WasmSession, executable, scenario) {
  const vault = mkdtempSync(join(tmpdir(), 'futo-merge-wasm-'));
  const worker = spawn(executable, [vault, scenario.base], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(worker, 'exit');
  const deadline = setTimeout(() => worker.kill(), 30_000);
  const lines = createInterface({ input: worker.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value);
  };
  const exchange = async (request) => {
    worker.stdin.write(JSON.stringify(request) + '\n');
    return next();
  };
  let page;
  try {
    page = WasmSession.restore(JSON.stringify(await next()));
    const send = async (applied) =>
      page.acknowledge(JSON.stringify(await exchange(applied.request)));
    await send(JSON.parse(page.replace(0n, scenario.start, scenario.end, 'LOCAL')));
    const merged = await exchange({
      merge: { base: scenario.base, draft: scenario.local, remote: scenario.remote },
    });
    assert.equal(merged.source, scenario.merged);
    const adoption = JSON.parse(page.adopt_merged_source(1n, merged.source));
    assert.equal(adoption.change.selection.end, scenario.selection);
    await send(adoption);
    const undo = JSON.parse(page.undo(2n));
    await send(undo);
    assert.equal(page.draft_text(), scenario.remote);
    assert.equal(JSON.parse(page.undo(3n)), null);
    await send(JSON.parse(page.redo(3n)));
    assert.equal(page.draft_text(), scenario.merged);
    worker.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0);
    assert.equal(readFileSync(join(vault, 'plain.md'), 'utf8'), scenario.merged);
  } finally {
    page?.free();
    if (worker.exitCode === null) {
      worker.kill();
      await exited;
    }
    clearTimeout(deadline);
    rmSync(vault, { recursive: true, force: true });
  }
}

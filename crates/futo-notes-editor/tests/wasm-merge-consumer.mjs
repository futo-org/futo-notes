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
  const vault = mkdtempSync(join(tmpdir(), 'futo-merge-wasm-'));
  const worker = spawn(executable, [vault, 'first\n\nsecond\n'], {
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
    await send(JSON.parse(page.replace(0n, 7, 13, 'LOCAL')));
    const renamed = await exchange({ external_rename: 'authoritative final (2)' });
    assert.equal(renamed.id, 'authoritative final (2)');
    assert.equal(page.draft_text(), 'first\n\nLOCAL\n');
    const merged = await exchange({
      merge: { base: 'first\n\nsecond\n', draft: 'first\n\nLOCAL\n', remote: '日本🦀\n\nsecond\n' },
    });
    assert.equal(merged.source, '日本🦀\n\nLOCAL\n');
    const adoption = JSON.parse(page.adopt_merged_source(1n, merged.source));
    assert.equal(adoption.change.selection.end, 17);
    await send(adoption);
    const undo = JSON.parse(page.undo(2n));
    await send(undo);
    assert.equal(page.draft_text(), '日本🦀\n\nsecond\n');
    assert.equal(JSON.parse(page.undo(3n)), null);
    await send(JSON.parse(page.redo(3n)));
    assert.equal(page.draft_text(), '日本🦀\n\nLOCAL\n');
    worker.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0);
    assert.equal(
      readFileSync(join(vault, 'authoritative final (2).md'), 'utf8'),
      '日本🦀\n\nLOCAL\n',
    );
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

// Synthetic literal seam/binding cases through actual compiled WASM + Rust store.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { savedSource } from './wasm-saved-source.mjs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);
const cases = ['structural-seams', 'fence-physical-rows'].flatMap((name) =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url))),
);
assert.equal(cases.length, 72);
const units = (text) => Uint16Array.from({ length: text.length }, (_, at) => text.charCodeAt(at));
function host(vault, source) {
  const worker = spawn(process.argv[3], [vault, source], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(worker, 'exit');
  const deadline = setTimeout(() => worker.kill(), 30_000);
  deadline.unref();
  const lines = createInterface({ input: worker.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value);
  };
  return {
    next,
    exchange: async (request) => {
      worker.stdin.write(request + '\n');
      return next();
    },
    close: async () => {
      worker.stdin.end();
      const [code] = await exited;
      clearTimeout(deadline);
      assert.equal(code, 0);
    },
  };
}
for (const item of cases) {
  const vault = mkdtempSync(join(tmpdir(), 'futo-editor-seams-'));
  let worker = host(vault, item.source),
    page;
  try {
    // Frozen clock: 500ms typing-run grouping must not depend on CI speed.
    page = WasmSession.restore_frozen_clock(JSON.stringify(await worker.next()));
    let display = item.display,
      revision = 0n,
      caret;
    const apply = async (applied) => {
      assert.ok(applied, item.name);
      // The page already shows the edit; the worker only mirrors it.
      const { change: delta, request } = JSON.parse(applied);
      const ack = await worker.exchange(JSON.stringify(request));
      assert.deepEqual(JSON.parse(page.acknowledge(JSON.stringify(ack))), []);
      assert.equal(delta.previous_revision, Number(revision));
      assert.equal(delta.revision, Number(++revision));
      const bytes = Buffer.from(display);
      display = Buffer.concat([
        bytes.subarray(0, delta.range.start),
        Buffer.from(delta.inserted),
        bytes.subarray(delta.range.end),
      ]).toString();
      caret = {
        start: Buffer.from(display).subarray(0, delta.selection.start).toString().length,
        end: Buffer.from(display).subarray(0, delta.selection.end).toString().length,
      };
    };
    if (item.mode === 'noop_indent') {
      assert.equal(JSON.parse(page.block_command_utf16(revision, 0, 0, '{"Heading":1}')), null);
      assert.equal(page.draft_text(), item.source);
      assert.equal(JSON.parse(page.status()).local, 0);
    }
    if (['noop_indent', 'indent', 'indent_os'].includes(item.mode))
      await apply(page.block_command_utf16(revision, 0, 0, '"Indent"'));
    if (item.mode === 'composition_commit') {
      for (const text of ['に', '日本']) {
        const marked = JSON.parse(page.compose_utf16(revision, ...item.range, units(text)));
        assert.equal(marked.text, text);
        assert.equal(page.draft_text(), item.source);
        assert.equal(JSON.parse(page.status()).local, 0);
      }
      page.cancel_composition(revision);
      assert.equal(JSON.parse(page.composition()), null);
      page.compose_utf16(revision, ...item.range, units(item.text));
      await apply(page.commit_composition_utf16(revision, null));
    } else if (item.mode === 'composition_batch') {
      page.compose_utf16(revision, ...item.range, units(item.text));
      assert.equal(page.draft_text(), item.source);
      await apply(
        page.replace_many_utf16(
          revision,
          JSON.stringify(
            item.replacements.map(([start, end, text]) => ({
              range: { start, end },
              inserted: Array.from(units(text)),
            })),
          ),
        ),
      );
      assert.equal(revision, 1n, 'composition + explicit runs have one protected append');
    } else if (['composition_os', 'distant_composition_os'].includes(item.mode)) {
      page.compose_utf16(
        revision,
        item.mode === 'distant_composition_os' ? 17 : 0,
        item.mode === 'distant_composition_os' ? 17 : 0,
        units('!'),
      );
      await apply(page.replace_os_utf16(revision, ...item.range, units(item.text), '[]'));
      assert.equal(revision, 1n, 'composition + OS input have one protected append');
    } else if (['os', 'indent_os'].includes(item.mode)) {
      await apply(page.replace_os_utf16(revision, ...item.range, units(item.text), '[]'));
    } else if (item.mode === 'typing_sequence') {
      if (item.format)
        assert.equal(JSON.parse(page.toggle_format(revision, JSON.stringify(item.format))), null);
      let next = { start: item.range[0], end: item.range[1] };
      for (const [action, text] of item.inputs) {
        await apply(
          page.replace_utf16_action(
            revision,
            next.start,
            next.end,
            units(text),
            JSON.stringify(action),
          ),
        );
        next = caret;
      }
    } else if (item.mode === 'typing') {
      await apply(
        page.replace_utf16_action(revision, ...item.range, units(item.text), '"Isolated"'),
      );
    } else if (item.mode === 'explicit') {
      const runs = item.replacements ?? [[...item.range, item.text]];
      await apply(
        page.replace_many_utf16(
          revision,
          JSON.stringify(
            runs.map(([start, end, text]) => ({
              range: { start, end },
              inserted: Array.from(units(text)),
            })),
          ),
        ),
      );
    } else if (item.mode === 'batch') {
      await apply(
        page.replace_many_utf16(
          revision,
          JSON.stringify([
            { range: { start: 0, end: 1 }, inserted: [33] },
            { range: { start: 1, end: 2 }, inserted: [63] },
            { range: { start: 3, end: 5 }, inserted: [65, 67] },
          ]),
        ),
      );
    }
    assert.equal(display, item.expectedDisplay, item.name);
    assert.equal(page.draft_text(), item.expectedSource, item.name);
    assert.deepEqual(caret, { start: item.caret, end: item.caret });
    for (let at = 0; at < item.history; at++) await apply(page.undo(revision));
    assert.equal(page.draft_text(), item.source);
    assert.equal(display, item.display);
    for (let at = 0; at < item.history; at++) await apply(page.redo(revision));
    assert.equal(page.draft_text(), item.expectedSource);
    assert.deepEqual(caret, {
      start: item.redoCaret ?? item.caret,
      end: item.redoCaret ?? item.caret,
    });
    await worker.close();
    worker = null;
    page.free();
    page = null;
    worker = host(vault, '--reopen');
    const recovered = await worker.next();
    assert.equal(recovered.source, savedSource(item.expectedSource));
    page = WasmSession.restore(JSON.stringify(recovered));
    assert.equal(
      JSON.parse(
        page.project(BigInt(recovered.revision), 0, Buffer.byteLength(item.expectedDisplay)),
      ).text,
      item.expectedDisplay,
    );
    await worker.exchange('{"checkpoint":true}');
    await worker.close();
    worker = null;
    page.free();
    page = null;
    worker = host(vault, '--reopen');
    assert.equal((await worker.next()).source, savedSource(item.expectedSource));
  } finally {
    page?.free();
    if (worker) await worker.close();
    rmSync(vault, { recursive: true });
  }
}
console.log(`Synthetic structural seam WASM/store consumers passed: ${cases.length}`);

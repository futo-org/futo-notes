// Synthetic literal list/binding cases through actual compiled WASM + Rust store.
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
const original = JSON.parse(readFileSync(new URL('fixtures/list-actions.json', import.meta.url)));
const shortcuts = JSON.parse(
  readFileSync(new URL('fixtures/list-shortcuts.json', import.meta.url)),
);
assert.equal(original.length, 27);
assert.equal(shortcuts.length, 38);
const staging = JSON.parse(readFileSync(new URL('fixtures/list-staging.json', import.meta.url)));
assert.equal(staging.length, 12);
const nested = JSON.parse(
  readFileSync(new URL('fixtures/nested-containers.json', import.meta.url)),
);
assert.equal(nested.length, 35);
const commands = JSON.parse(
  readFileSync(new URL('fixtures/container-commands.json', import.meta.url)),
);
assert.equal(commands.length, 27);
const headers = JSON.parse(
  readFileSync(new URL('fixtures/list-header-commands.json', import.meta.url)),
);
assert.equal(headers.length, 14);
const frames = JSON.parse(
  readFileSync(new URL('fixtures/prefix-frame-commands.json', import.meta.url)),
);
assert.equal(frames.length, 40);
const fences = JSON.parse(
  readFileSync(new URL('fixtures/fence-container-commands.json', import.meta.url)),
);
assert.equal(fences.length, 23);
const headings = JSON.parse(
  readFileSync(new URL('fixtures/heading-quote-commands.json', import.meta.url)),
);
assert.equal(headings.length, 5);
const cases = [
  ...original,
  ...shortcuts,
  ...staging,
  ...nested,
  ...commands,
  ...headers,
  ...frames,
  ...fences,
  ...headings,
];
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
function assertItems(page, revision, display, item) {
  const end = Buffer.byteLength(display);
  const blocks = JSON.parse(page.project(revision, 0, end)).blocks;
  for (const block of JSON.parse(page.project(revision, end, end)).blocks)
    if (!blocks.some((old) => JSON.stringify(old) === JSON.stringify(block))) blocks.push(block);
  const items = blocks
    .filter((block) => block.list?.first)
    .map((block, index) => {
      assert.equal(block.list.depth, item.itemDepths?.[index] ?? 1);
      assert.equal(block.quote_depth, item.itemQuoteDepths?.[index] ?? item.quoteDepth ?? 0);
      return [block.list.number, block.list.checked];
    });
  assert.deepEqual(items, item.finalItems, item.name);
}
for (const item of cases) {
  const vault = mkdtempSync(join(tmpdir(), 'futo-editor-lists-'));
  let worker = host(vault, item.source),
    page;
  try {
    page = WasmSession.restore(JSON.stringify(await worker.next()));
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
      caret = [
        Buffer.from(display).subarray(0, delta.selection.start).toString().length,
        Buffer.from(display).subarray(0, delta.selection.end).toString().length,
      ];
    };
    assert.equal(JSON.parse(page.project(revision, 0, Buffer.byteLength(display))).text, display);
    const initial = item.selection ?? item.range;
    page.select_with_affinity(
      revision,
      ...initial.map((at) => Buffer.byteLength(display.slice(0, at))),
      '"Forward"',
    );
    if (item.composeRange) {
      page.compose_utf16(revision, ...item.composeRange, units(item.compositionText ?? item.text));
      assert.equal(page.draft_text(), item.source);
    }
    const request = () =>
      item.action === 'Typing'
        ? page.replace_utf16_action(revision, ...item.range, units(item.text), '"Typing"')
        : ['Enter', 'Backspace', 'Delete'].includes(item.action)
          ? page.paragraph_key_utf16(revision, ...item.range, JSON.stringify(item.action))
          : page.block_command_utf16(
              revision,
              ...item.range,
              JSON.stringify(
                item.action === 'Text'
                  ? { Heading: 0 }
                  : item.action === 'Heading2'
                    ? { Heading: 2 }
                    : item.action === 'ComposeToggleTask'
                      ? 'ToggleTask'
                      : item.action,
              ),
            );
    if (item.refused) {
      // Outside the generic list path: refused before any store append.
      assert.throws(request, /Unrepresentable/, item.name);
      assert.equal(page.draft_text(), item.source, item.name);
      continue;
    }
    await apply(request());
    assert.equal(revision, 1n, 'one protected append');
    assert.equal(page.draft_text(), item.expected, item.name);
    assert.equal(display, item.shown, item.name);
    assert.deepEqual(caret, item.resultRange, item.name);
    assertItems(page, revision, display, item);
    const histories = item.undoSources?.length ?? 1;
    for (let step = 0; step < histories; step++) {
      await apply(page.undo(revision));
      assert.equal(page.draft_text(), item.undoSources?.[step] ?? item.source);
      assert.equal(display, item.undoDisplays?.[step] ?? item.display);
      assert.deepEqual(caret, item.undoRanges?.[step] ?? initial);
    }
    assert.equal(JSON.parse(page.undo(revision)), null);
    for (let step = 0; step < histories; step++) await apply(page.redo(revision));
    assert.equal(page.draft_text(), item.expected);
    assert.equal(display, item.shown);
    assert.deepEqual(caret, item.resultRange);
    await worker.close();
    worker = null;
    page.free();
    page = null;
    worker = host(vault, '--reopen');
    const recovered = await worker.next();
    assert.equal(recovered.source, savedSource(item.expected));
    page = WasmSession.restore(JSON.stringify(recovered));
    assert.equal(
      JSON.parse(page.project(BigInt(recovered.revision), 0, Buffer.byteLength(item.shown))).text,
      item.shown,
    );
    assertItems(page, BigInt(recovered.revision), item.shown, item);
    assert.equal(JSON.parse(page.undo(BigInt(recovered.revision))), null);
    await worker.exchange('{"checkpoint":true}');
    await worker.close();
    worker = null;
    page.free();
    page = null;
    worker = host(vault, '--reopen');
    assert.equal((await worker.next()).source, savedSource(item.expected));
  } finally {
    page?.free();
    if (worker) await worker.close();
    rmSync(vault, { recursive: true });
  }
}
console.log(`Synthetic list WASM/store consumers passed: ${cases.length}`);

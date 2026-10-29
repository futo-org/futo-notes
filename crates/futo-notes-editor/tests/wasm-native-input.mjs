// Actual captured UIKit results through compiled WASM and the public Rust store host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';

const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);
const fixtures = new URL('../../../tests/fixtures/editor-native-input/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, fixtures)));
const text = (units) => String.fromCharCode(...units);
const units = (string) =>
  Uint16Array.from({ length: string.length }, (_, index) => string.charCodeAt(index));
const bytesAt = (string, offset) => Buffer.byteLength(string.slice(0, offset));
function host(vault, source) {
  const worker = spawn(process.argv[3], [vault, source], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(worker, 'exit');
  const deadline = setTimeout(() => worker.kill(), 30_000);
  deadline.unref();
  const lines = createInterface({ input: worker.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    assert.equal(line.done, false, 'store worker must reply');
    return JSON.parse(line.value);
  };
  return {
    next,
    exchange: async (request) => {
      worker.stdin.write(JSON.stringify(request) + '\n');
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
const cases = read('native-input-cases');
assert.equal(cases.length, 5);
for (const fixture of cases) {
  for (const [file, expectedHash] of Object.entries(fixture.fixtureSha256)) {
    const raw = readFileSync(new URL(`${file}.json`, fixtures));
    assert.equal(createHash('sha256').update(raw).digest('hex'), expectedHash);
  }
  const { eventFiles, ...trace } = read(fixture.name);
  trace.events = eventFiles.flatMap(read);
  const vault = mkdtempSync(join(tmpdir(), 'futo-native-input-wasm-'));
  const worker = host(vault, fixture.source);
  let page;
  try {
    page = WasmSession.restore(JSON.stringify(await worker.next()));
    let view = fixture.display;
    let revision = 0n;
    const apply = async (request) => {
      const before = view;
      assert.equal(JSON.parse(page.status()).accepted, Number(revision));
      const ack = await worker.exchange(request);
      assert.equal(view, before, 'display waits for real store acceptance');
      const change = JSON.parse(page.acknowledge(JSON.stringify(ack)));
      assert.equal(change.previous_revision, Number(revision));
      revision += 1n;
      assert.equal(change.revision, Number(revision));
      const bytes = Buffer.from(view);
      view = Buffer.concat([
        bytes.subarray(0, change.range.start),
        Buffer.from(change.inserted),
        bytes.subarray(change.range.end),
      ]).toString();
      assert.equal(
        JSON.parse(page.acknowledge(JSON.stringify(ack))),
        null,
        'duplicate acknowledgement',
      );
      return change;
    };
    const select = (snapshot) => {
      const [start, end] = snapshot.selected.map((n) => bytesAt(view, n));
      const result = JSON.parse(page.select_with_affinity(revision, start, end, '"Backward"'));
      assert.deepEqual(result.selection, { start, end });
    };
    for (const step of fixture.steps) {
      const event = trace.events.find((event) => event.id === step.event);
      const snapshot = event.after;
      if (step.operation === 'select') select(snapshot);
      else if (step.operation === 'marked') {
        assert.equal(event.method, 'didChange');
        assert.equal(event.parent, null);
        const [start, end] = snapshot.marked;
        const overlay = JSON.parse(
          page.compose_utf16(
            revision,
            ...fixture.range,
            new Uint16Array(snapshot.textUTF16.slice(start, end)),
          ),
        );
        const bytes = Buffer.from(view);
        const displayed = Buffer.concat([
          bytes.subarray(0, overlay.range.start),
          Buffer.from(overlay.text),
          bytes.subarray(overlay.range.end),
        ]).toString();
        assert.equal(displayed, text(snapshot.textUTF16));
        assert.equal(JSON.parse(page.status()).accepted, Number(revision));
      } else {
        let request;
        if (step.operation === 'commit') {
          assert.equal(trace.events.find((e) => e.id === event.parent).method, 'unmarkText');
          request = JSON.parse(page.commit_composition_utf16(revision));
        } else if (step.operation === 'typing') {
          const parent = trace.events.find((e) => e.id === event.parent);
          assert.equal(parent.method, 'insertText');
          assert.equal(text(parent.before.textUTF16), view);
          request = JSON.parse(
            page.replace_utf16(
              revision,
              ...parent.before.selected,
              new Uint16Array(parent.arguments.textUTF16),
            ),
          );
        } else {
          assert.equal(step.operation, 'replace');
          request = JSON.parse(
            page.replace_os_utf16(revision, ...step.serviceRange, units(step.serviceText), '[]'),
          );
        }
        const change = await apply(request);
        assert.equal(view, text(snapshot.textUTF16));
        assert.deepEqual(change.selection, {
          start: bytesAt(view, snapshot.selected[0]),
          end: bytesAt(view, snapshot.selected[1]),
        });
      }
      assert.equal(page.draft_text(), step.source, `${fixture.name} callback ${step.event}`);
    }
    assert.equal(view, text(trace.current.textUTF16));
    assert.equal(JSON.parse(page.commit_composition_utf16(revision)), null);
    for (const expected of fixture.history.slice(0, -1).reverse()) {
      const change = await apply(JSON.parse(page.undo(revision)));
      assert.deepEqual(change.selection, {
        start: bytesAt(view, (expected.undoSelection ?? expected.selection)[0]),
        end: bytesAt(view, (expected.undoSelection ?? expected.selection)[1]),
      });
      assert.equal(page.draft_text(), expected.source);
      assert.equal(view, expected.display);
    }
    assert.equal(JSON.parse(page.undo(revision)), null);
    for (const expected of fixture.history.slice(1)) {
      const change = await apply(JSON.parse(page.redo(revision)));
      assert.deepEqual(change.selection, {
        start: bytesAt(view, expected.selection[0]),
        end: bytesAt(view, expected.selection[1]),
      });
      assert.equal(page.draft_text(), expected.source);
      assert.equal(view, expected.display);
    }
    page.acknowledge(JSON.stringify(await worker.exchange(JSON.parse(page.flush()))));
    assert.equal(JSON.parse(page.status()).durable, Number(revision));
    await worker.close();
    const reopened = host(vault, '--reopen');
    try {
      const recovered = await reopened.next();
      assert.equal(recovered.source, fixture.steps.at(-1).source);
      assert.equal(recovered.revision, Number(revision));
    } finally {
      await reopened.close();
    }
  } finally {
    page?.free();
    // A failed assertion must still release only this test's worker and scratch vault.
    await worker.close();
    rmSync(vault, { recursive: true });
  }
}
console.log('Captured UIKit / compiled WASM / real store recovery: all literal traces passed.');

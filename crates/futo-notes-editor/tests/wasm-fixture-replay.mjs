// Replays the core's literal command cases (`fixtures/engine/`) through the
// compiled WASM session and the real Rust store worker: every edit crosses the
// worker once, and the saved bytes, Undo and Redo are checked against the case.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';

const BLOCK = new Set([
  'Quote',
  'Indent',
  'Outdent',
  'Divider',
  'ToggleTask',
  'BulletList',
  'OrderedList',
  'TaskList',
  'CodeBlock',
  'WrapCodeBlock',
]);
const KEYS = new Set([
  'Enter',
  'ShiftEnter',
  'Backspace',
  'BackspaceJoiningHeading',
  'Delete',
  'Tab',
  'ShiftTab',
]);

/// The cases of `file` (relative to `fixtures/engine/`) whose command the
/// replayer runs: block commands, paragraph keys and typing.
export function fixtureCases(file) {
  const cases = JSON.parse(readFileSync(new URL(`fixtures/engine/${file}`, import.meta.url)));
  return cases.filter((item) => typeof item.command === 'string' && command(item.command));
}

function command(text) {
  const typed = /^type[: ]([\s\S]*)$/.exec(text);
  if (typed) return { type: typed[1] };
  const heading = /^(Toggle)?Heading\((\d)\)$/.exec(text);
  if (heading) return { block: { [heading[1] ? 'ToggleHeading' : 'Heading']: Number(heading[2]) } };
  if (BLOCK.has(text)) return { block: text };
  if (KEYS.has(text)) return { key: text };
  return null;
}

/// The note without its marks and the marked source range, in UTF-8 bytes:
/// `caret` alone, or `start`…`end`. With a caret, the others are text.
function unmark(marked, [caret, start, end]) {
  if (marked.includes(caret)) [start, end] = [undefined, undefined];
  let text = '';
  let from;
  let to;
  for (const ch of marked) {
    if (ch === caret) from = to = Buffer.byteLength(text);
    else if (ch === start) from = Buffer.byteLength(text);
    else if (ch === end) to = Buffer.byteLength(text);
    else text += ch;
  }
  assert.ok(from !== undefined && to !== undefined, `marks in ${JSON.stringify(marked)}`);
  return { text, from, to };
}

function worker(path, vault, source) {
  const child = spawn(path, [vault, source], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  const deadline = setTimeout(() => child.kill(), 30_000);
  deadline.unref();
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value);
  };
  return {
    next,
    exchange: async (request) => {
      child.stdin.write(JSON.stringify(request) + '\n');
      return next();
    },
    close: async () => {
      child.stdin.end();
      const [code] = await exited;
      clearTimeout(deadline);
      assert.equal(code, 0);
    },
  };
}

/// The page's whole display text at `revision`.
function displayText(page, revision, source) {
  let low = 0;
  let high = source.length + 8;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    let fits = true;
    try {
      page.utf16_to_display(revision, mid, mid);
    } catch {
      fits = false;
    }
    if (fits) low = mid;
    else high = mid - 1;
  }
  const end = JSON.parse(page.utf16_to_display(revision, low, low)).end;
  return JSON.parse(page.project(revision, 0, end));
}

/// The display offset source byte `at` shows at, and the affinity that puts
/// a caret at exactly `at`: Forward when hidden syntax ends there.
function toDisplay(slice, at) {
  let shown;
  let affinity = 'Backward';
  for (const { source, display, kind } of slice.correspondence) {
    if (at < source.start || at > source.end) continue;
    if (kind === 'Hidden' && source.start < at && source.end === at) affinity = 'Forward';
    if (shown !== undefined) continue;
    if (kind === 'Literal') shown = display.start + (at - source.start);
    else shown = at === source.end ? display.end : display.start;
  }
  return { at: shown ?? Buffer.byteLength(slice.text), affinity };
}

const units = (text, bytes) => Buffer.from(text).subarray(0, bytes).toString().length;

/// Replay `cases`, each marked with `marks` (caret, selection start, end)
/// unless the case names its own.
export async function replay(WasmSession, workerPath, cases, marks) {
  for (const item of cases) {
    const own = item.marks ? [...item.marks] : marks;
    const before = unmark(item.before, own);
    const after = unmark(item.after, own);
    const vault = mkdtempSync(join(tmpdir(), 'futo-editor-wasm-fixture-'));
    const host = worker(workerPath, vault, before.text);
    let page;
    try {
      page = WasmSession.restore(JSON.stringify(await host.next()));
      let revision = 0n;
      const send = async (applied) => {
        if (applied === null || applied === 'null') return false;
        const { change, request } = JSON.parse(applied);
        const ack = await host.exchange(request);
        assert.deepEqual(JSON.parse(page.acknowledge(JSON.stringify(ack))), [], item.name);
        revision = BigInt(change.revision);
        return true;
      };
      const slice = displayText(page, revision, before.text);
      const start = toDisplay(slice, before.from);
      const end = toDisplay(slice, before.to);
      page.select_with_affinity(
        revision,
        start.at,
        end.at,
        JSON.stringify(before.from === before.to ? start.affinity : 'Forward'),
      );
      const [a, b] = [units(slice.text, start.at), units(slice.text, end.at)];
      const run = command(item.command);
      const changed = await send(
        run.type !== undefined
          ? page.replace_utf16(
              revision,
              a,
              b,
              Uint16Array.from(run.type, (_, i) => run.type.charCodeAt(i)),
            )
          : run.block !== undefined
            ? page.block_command_utf16(revision, a, b, JSON.stringify(run.block))
            : page.paragraph_key_utf16(revision, a, b, JSON.stringify(run.key)),
      );
      assert.equal(page.draft_text(), after.text, `${item.name}: saved bytes`);
      if (!changed) continue;
      await send(page.undo(revision));
      assert.equal(page.draft_text(), before.text, `${item.name}: undo`);
      await send(page.redo(revision));
      assert.equal(page.draft_text(), after.text, `${item.name}: redo`);
    } finally {
      page?.free();
      await host.close();
      rmSync(vault, { recursive: true });
    }
  }
}

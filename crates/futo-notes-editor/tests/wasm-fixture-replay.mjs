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
  'OpenLineBeforeCodeBlock',
  'OpenLineAfterCodeBlock',
  'OpenCodeLineBelow',
  'OpenCodeLineAbove',
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

/// Every case of `file` (relative to `fixtures/engine/`): block commands,
/// paragraph keys, typing, a text service's replacement, paste, cut,
/// selecting a code block, setting its header, and a selection sent again as
/// a host's echo or as the user's own. A command the replayer cannot run fails here
/// rather than being left out.
export function fixtureCases(file) {
  const cases = JSON.parse(readFileSync(new URL(`fixtures/engine/${file}`, import.meta.url)));
  for (const item of cases) assert.ok(command(item.command), `${file}: ${item.name}: command`);
  return cases;
}

function command(text) {
  if (typeof text !== 'string') return null;
  const typed = /^type[: ]([\s\S]*)$/.exec(text);
  if (typed) return { type: typed[1] };
  const service = /^os:([\s\S]*)$/.exec(text);
  if (service) return { service: service[1] };
  const pasted = /^paste:([\s\S]*)$/.exec(text);
  if (pasted) return { paste: pasted[1] };
  if (text === 'Cut') return { cut: true };
  if (text === 'SelectBlock') return { selectBlock: true };
  if (text === 'Select') return { echo: true };
  if (text === 'Place') return { place: true };
  const header = /^header:([\s\S]*?)\|([\s\S]*)$/.exec(text);
  if (header) return { header: { language: header[1], name: header[2] } };
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

/// The page's whole display projected at `revision`.
function displayText(page, revision) {
  return JSON.parse(page.project(revision, 0, page.display_len()));
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
const utf16 = (text) => Uint16Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));

/// Set the header of the block at display byte `at`; the edit as JSON, or
/// null where the engine refused it with `error` or it changed no source.
function headerSet(page, revision, header, { at, error }) {
  try {
    const set = page.set_code_block_header(revision, JSON.stringify({ at, ...header }));
    assert.equal(error, undefined, `header set, wanted ${error}`);
    return set;
  } catch (refusal) {
    if (refusal instanceof assert.AssertionError) throw refusal;
    assert.ok(error && String(refusal).includes(error), `header refusal: ${refusal}`);
    return null;
  }
}

/// Run `run` over the selection (`a`…`b` in UTF-16 units, `bytes` in display
/// bytes); the edit it applied as JSON, or null when it changed no source.
function applied(page, revision, run, { a, b, bytes, at, error }) {
  if (run.header) {
    return headerSet(page, revision, run.header, { at: at ?? bytes.start, error });
  }
  if (run.echo) {
    page.select_with_affinity(revision, bytes.start, bytes.end, page.affinity());
    return null;
  }
  if (run.place) {
    page.place_selection(revision, bytes.start, bytes.end, page.affinity());
    return null;
  }
  if (run.type !== undefined) return page.replace_utf16(revision, a, b, utf16(run.type));
  if (run.service !== undefined) {
    return page.replace_utf16_action(revision, a, b, utf16(run.service), '"Isolated"');
  }
  if (run.paste !== undefined) {
    return page.paste_markdown(revision, bytes.start, bytes.end, run.paste);
  }
  if (run.cut) {
    const [, cut] = JSON.parse(page.cut_markdown(revision, bytes.start, bytes.end));
    return cut === null ? null : JSON.stringify(cut);
  }
  if (run.selectBlock) {
    page.select_code_block(revision, bytes.start);
    return null;
  }
  if (run.block !== undefined) {
    return page.block_command_utf16(revision, a, b, JSON.stringify(run.block));
  }
  return page.paragraph_key_utf16(revision, a, b, JSON.stringify(run.key));
}

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
        return change;
      };
      const slice = displayText(page, revision);
      const start = toDisplay(slice, before.from);
      const end = toDisplay(slice, before.to);
      page.select_with_affinity(
        revision,
        start.at,
        end.at,
        JSON.stringify(before.from === before.to ? start.affinity : 'Forward'),
      );
      // The selection in display bytes, and in UTF-16 units as `a`…`b`.
      let bytes = { start: start.at, end: end.at };
      if (item.block) bytes = JSON.parse(page.select_code_block(revision, start.at)).selection;
      let [a, b] = [units(slice.text, bytes.start), units(slice.text, bytes.end)];
      if (item.typed !== undefined) {
        const setup = await send(page.replace_utf16(revision, a, b, utf16(item.typed)));
        assert.ok(setup, `${item.name}: typed setup`);
        const shown = displayText(page, revision);
        bytes = setup.selection;
        [a, b] = [units(shown.text, bytes.start), units(shown.text, bytes.end)];
      }
      const opening = page.draft_text();
      const run = command(item.command);
      const changed = await send(
        applied(page, revision, run, { a, b, bytes, at: item.at, error: item.error }),
      );
      assert.equal(page.draft_text(), after.text, `${item.name}: saved bytes`);
      if (item.selected !== undefined) {
        const selected = JSON.parse(page.selected_block()) !== null;
        assert.equal(selected, item.selected, `${item.name}: selected block`);
      }
      if (item.language !== undefined || run.header || run.echo || run.place) {
        assert.equal(page.writes_language(), item.language ?? false, `${item.name}: language`);
      }
      if (!changed) continue;
      await send(page.undo(revision));
      assert.equal(page.draft_text(), opening, `${item.name}: undo`);
      await send(page.redo(revision));
      assert.equal(page.draft_text(), after.text, `${item.name}: redo`);
    } finally {
      page?.free();
      await host.close();
      rmSync(vault, { recursive: true });
    }
  }
}

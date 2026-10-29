// Actual WASM editor <-> Rust store worker, with an independent display view.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import { runBlockRegressions } from './wasm-block-consumer.mjs';
const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);

(async () => {
  const vault = mkdtempSync(join(tmpdir(), 'futo-editor-wasm-'));
  const worker = spawn(process.argv[3], [vault], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(worker, 'exit');
  const deadline = setTimeout(() => worker.kill(), 30_000);
  deadline.unref();
  const lines = createInterface({ input: worker.stdout })[Symbol.asyncIterator]();
  let page;
  try {
    const next = async () => {
      const line = await lines.next();
      assert.equal(line.done, false, 'worker must return a reply');
      return JSON.parse(line.value);
    };
    const exchange = async (request) => {
      worker.stdin.write(JSON.stringify(request) + '\n');
      return next();
    };
    assert.throws(() => new WasmSession(9_007_199_254_740_992n, '', 0n, 0n));
    const initial = await next();
    assert.equal(initial.source, '__a__\r\n');
    page = WasmSession.restore(JSON.stringify(initial));
    const opening = JSON.parse(page.project(0n, 0, 3));
    assert.equal(opening.text, 'a\r\n');
    assert.deepEqual(opening.runs[0].formats, ['Bold']);
    assert.ok(opening.correspondence.some((part) => part.display.start === part.display.end));
    let text = opening.text;
    const apply = (change) => {
      assert.ok(change);
      const bytes = Buffer.from(text);
      text = Buffer.concat([
        bytes.subarray(0, change.range.start),
        Buffer.from(change.inserted),
        bytes.subarray(change.range.end),
      ]).toString();
    };
    const request = JSON.parse(page.replace(0n, 1, 1, '🎉'));
    assert.equal(page.draft_text(), '__a🎉__\r\n');
    assert.equal(text, 'a\r\n');
    assert.equal(JSON.parse(page.status()).accepted, 0);
    assert.throws(() => page.replace(1n, 1, 1, '?'));
    const ack = await exchange(request);
    assert.equal(ack.accepted, 1);
    assert.equal(ack.durable, 0);
    assert.equal(JSON.parse(page.acknowledge(JSON.stringify({ ...ack, token: 99 }))), null);
    assert.equal(JSON.parse(page.status()).accepted, 0);
    assert.deepEqual(await exchange(request), ack);
    apply(JSON.parse(page.acknowledge(JSON.stringify(ack))));
    assert.equal(text, 'a🎉\r\n');
    assert.equal(JSON.parse(page.acknowledge(JSON.stringify(ack))), null);
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.undo(1n)))))));
    assert.equal(text, 'a\r\n');
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.redo(2n)))))));
    assert.equal(text, 'a🎉\r\n');
    const selection = JSON.parse(page.select_with_affinity(3n, 0, 5, '"Forward"'));
    assert.equal(selection.affinity, 'Forward');
    const toggle = JSON.parse(page.toggle_format(3n, '"Strike"'));
    assert.throws(() => page.project(4n, 0, 7));
    const rich = JSON.parse(page.acknowledge(JSON.stringify(await exchange(toggle))));
    apply(rich);
    assert.equal(text, 'a🎉\r\n');
    assert.equal(page.draft_text(), '~~__a🎉__~~\r\n');
    assert.equal(rich.affinity, 'Forward');
    assert.deepEqual(rich.projection.runs[0].formats, ['Bold', 'Strike']);
    assert.deepEqual(JSON.parse(page.project(4n, 0, 7)), rich.projection);
    const entity = JSON.parse(page.replace(4n, 0, 5, '&acE;'));
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(entity)))));
    assert.equal(text, '∾\u0333\r\n');
    assert.equal(page.draft_text(), '~~__&acE;__~~\r\n');
    const entityProjection = JSON.parse(page.project(5n, 0, 7));
    assert.ok(
      entityProjection.correspondence.some(
        (part) =>
          part.source.start === 4 &&
          part.source.end === 9 &&
          part.display.start === 0 &&
          part.display.end === 5,
      ),
    );
    for (const affinity of ['Backward', 'Forward']) {
      assert.deepEqual(JSON.parse(page.select_with_affinity(5n, 3, 3, JSON.stringify(affinity))), {
        revision: 5,
        selection: { start: 3, end: 3 },
        affinity,
      });
    }
    const partialEntity = JSON.parse(page.replace_utf16(5n, 1, 2, new Uint16Array([120])));
    const entityChange = JSON.parse(
      page.acknowledge(JSON.stringify(await exchange(partialEntity))),
    );
    apply(entityChange);
    assert.equal(text, '∾x\r\n');
    assert.equal(page.draft_text(), '~~__&#8766;x__~~\r\n');
    assert.deepEqual(entityChange.selection, { start: 4, end: 4 });
    assert.deepEqual(entityChange.projection.runs[0].formats, ['Bold', 'Strike']);
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.undo(6n)))))));
    assert.equal(text, '∾\u0333\r\n');
    assert.equal(page.draft_text(), '~~__&acE;__~~\r\n');
    assert.deepEqual(JSON.parse(page.project(7n, 0, 7)), { ...entityProjection, revision: 7 });
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.redo(7n)))))));
    assert.equal(text, '∾x\r\n');
    assert.equal(page.draft_text(), '~~__&#8766;x__~~\r\n');
    // Composition commits and multi-run keyboard corrections are explicit,
    // isolated actions; each crosses the real store once before display.
    const commit = JSON.parse(
      page.replace_utf16_action(8n, 2, 2, new Uint16Array([0x65e5]), '"CompositionCommit"'),
    );
    assert.equal(text, '∾x\r\n');
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(commit)))));
    assert.equal(page.draft_text(), '~~__&#8766;x日__~~\r\n');
    assert.equal(text, '∾x日\r\n');
    const runs = JSON.stringify([
      { range: { start: 0, end: 1 }, inserted: [0xd83d, 0xde00] },
      { range: { start: 1, end: 2 }, inserted: [0x7a] },
    ]);
    const compound = JSON.parse(page.replace_many_utf16(9n, runs));
    assert.equal(compound.operation.Append.previous_revision, 9);
    assert.equal(compound.operation.Append.revision, 10);
    assert.throws(() => page.undo(10n));
    assert.equal(text, '∾x日\r\n');
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(compound)))));
    assert.equal(page.draft_text(), '~~__😀z日__~~\r\n');
    assert.equal(text, '😀z日\r\n');
    assert.throws(() =>
      page.replace_many_utf16(
        10n,
        JSON.stringify([
          { range: { start: 0, end: 2 }, inserted: [0x61] },
          { range: { start: 2, end: 3 }, inserted: [0xd800] },
        ]),
      ),
    );
    assert.equal(JSON.parse(page.status()).waiting, false);
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.undo(10n)))))));
    assert.equal(page.draft_text(), '~~__&#8766;x日__~~\r\n');
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.undo(11n)))))));
    assert.equal(page.draft_text(), '~~__&#8766;x__~~\r\n');
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.redo(12n)))))));
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.redo(13n)))))));
    assert.equal(page.draft_text(), '~~__😀z日__~~\r\n');
    assert.equal(text, '😀z日\r\n');
    // A resulting selection echo keeps the carried marks across a trailing
    // space, without platform-side grouping or formatting heuristics.
    page.select_with_affinity(14n, 8, 8, '"Backward"');
    apply(
      JSON.parse(
        page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.replace(14n, 8, 8, ' '))))),
      ),
    );
    assert.equal(page.draft_text(), '~~__😀z日__~~ \r\n');
    page.select_with_affinity(15n, 9, 9, '"Backward"');
    apply(
      JSON.parse(
        page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.replace(15n, 9, 9, 'b'))))),
      ),
    );
    assert.equal(page.draft_text(), '~~__😀z日 b__~~\r\n');
    assert.equal(text, '😀z日 b\r\n');
    assert.deepEqual(new Set(JSON.parse(page.active_formats())), new Set(['Bold', 'Strike']));
    // Paragraph keys use the supplied UTF-16 range despite a distant stored
    // caret, and cross the same store acknowledgement boundary as text input.
    page.select_with_affinity(16n, 0, 0, '"Forward"');
    const enter = JSON.parse(page.paragraph_key_utf16(16n, 2, 2, '"Enter"'));
    assert.equal(text, '😀z日 b\r\n');
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(enter)))));
    assert.equal(text, '😀\nz日 b\r\n');
    assert.equal(page.draft_text(), '~~__😀\nz日 b__~~\r\n');
    const backspace = JSON.parse(page.paragraph_key_utf16(17n, 3, 3, '"Backspace"'));
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(backspace)))));
    assert.equal(text, '😀z日 b\r\n');
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.undo(18n)))))));
    assert.equal(text, '😀\nz日 b\r\n');
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.undo(19n)))))));
    assert.equal(text, '😀z日 b\r\n');
    assert.equal(JSON.parse(page.paragraph_key_utf16(20n, 0, 0, '"Backspace"')), null);
    const heading = JSON.parse(page.block_command_utf16(20n, 0, 0, '{"Heading":6}'));
    assert.equal(text, '😀z日 b\r\n');
    const headingChange = JSON.parse(page.acknowledge(JSON.stringify(await exchange(heading))));
    apply(headingChange);
    assert.equal(headingChange.projection.blocks[0].heading, 6);
    assert.equal(page.draft_text(), '###### ~~__😀z日 b__~~\r\n');
    assert.equal(text, '😀z日 b\r\n');
    const blockEnter = JSON.parse(page.paragraph_key_utf16(21n, 3, 3, '"Enter"'));
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(blockEnter)))));
    assert.equal(page.draft_text(), '###### ~~__😀z__~~\n~~__日 b__~~\r\n');
    assert.equal(text, '😀z\n日 b\r\n');
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.undo(22n)))))));
    assert.equal(page.draft_text(), '###### ~~__😀z日 b__~~\r\n');
    const marked = JSON.parse(
      page.compose_utf16(23n, 3, 4, new Uint16Array([0x306b, 0x307b, 0x3093])),
    );
    assert.equal(marked.text, 'にほん');
    assert.equal(page.draft_text(), '###### ~~__😀z日 b__~~\r\n');
    assert.equal(JSON.parse(page.undo(23n)), null);
    assert.throws(() => page.compose_utf16(23n, 3, 4, new Uint16Array([0xd800])));
    assert.throws(
      () => page.replace_utf16_action(23n, 3, 6, new Uint16Array([0x65e5]), '"CompositionCommit"'),
      /CompositionActive/,
    );
    const markedCommit = JSON.parse(
      page.commit_composition_utf16(23n, new Uint16Array([0x65e5, 0x672c])),
    );
    assert.equal(text, '😀z日 b\r\n');
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(markedCommit)))));
    assert.equal(text, '😀z日本 b\r\n');
    assert.equal(page.draft_text(), '###### ~~__😀z日本 b__~~\r\n');
    assert.equal(JSON.parse(page.commit_composition_utf16(24n)), null);
    for (const [revision, command, expected] of [
      [24n, '"Quote"', '> ~~__😀z日本 b__~~\r\n'],
      [25n, '"Indent"', '> > ~~__😀z日本 b__~~\r\n'],
      [26n, '"Outdent"', '> ~~__😀z日本 b__~~\r\n'],
    ]) {
      const request = JSON.parse(page.block_command_utf16(revision, 0, 0, command));
      apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(request)))));
      assert.equal(page.draft_text(), expected);
      assert.equal(text, '😀z日本 b\r\n');
    }
    const divider = JSON.parse(page.block_command_utf16(27n, 7, 7, '"Divider"'));
    const dividerChange = JSON.parse(page.acknowledge(JSON.stringify(await exchange(divider))));
    apply(dividerChange);
    assert.equal(page.draft_text(), '> ~~__😀z日本 b__~~\n> ***\n> \r\n');
    assert.equal(text, '😀z日本 b\n\ufffc\n\r\n');
    assert.ok(dividerChange.projection.blocks.some((block) => block.divider));
    const flush = JSON.parse(page.flush());
    assert.equal(JSON.parse(page.status()).durable, 0);
    page.acknowledge(JSON.stringify(await exchange(flush)));
    assert.equal(JSON.parse(page.status()).durable, 28);
  } finally {
    clearTimeout(deadline);
    page?.free();
    worker.stdin.end();
    const [code] = await exited;
    rmSync(vault, { recursive: true });
    assert.equal(code, 0);
  }
  await runBlockRegressions();
  console.log(
    'Compiled WASM / Rust store consumer: ordered edit/undo/redo/append/flush and block regressions passed.',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

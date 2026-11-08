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
import { runMergeRegressions } from './wasm-merge-consumer.mjs';
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
    // The page already shows `applied.change`; this sends its request and
    // returns the change once the worker has acknowledged it.
    const send = async (applied) => {
      assert.deepEqual(
        JSON.parse(page.acknowledge(JSON.stringify(await exchange(applied.request)))),
        [],
      );
      return applied.change;
    };
    assert.throws(() => new WasmSession(9_007_199_254_740_992n, '', 0n));
    const initial = await next();
    assert.equal(initial.source, '__a__\r\n');
    page = WasmSession.restore(JSON.stringify(initial));
    const opening = JSON.parse(page.project(0n, 0, 3));
    assert.equal(opening.text, 'a\r\n');
    assert.deepEqual(opening.runs[0].formats, ['Bold']);
    assert.ok(
      opening.correspondence.some(
        (part) => part.kind === 'Hidden' && part.display.start === part.display.end,
      ),
    );
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
    const first = JSON.parse(page.replace(0n, 1, 1, '🎉'));
    const request = first.request;
    // The edit shows at once; the worker has not seen it yet.
    apply(first.change);
    assert.equal(page.draft_text(), '__a🎉__\r\n');
    assert.equal(text, 'a🎉\r\n');
    assert.deepEqual(JSON.parse(page.status()), {
      local: 1,
      accepted: 0,
      paused: false,
      outstanding: 1,
    });
    // Queries do not wait for the acknowledgement.
    assert.ok(page.project(1n, 0, 7));
    const ack = await exchange(request);
    assert.equal(ack.accepted, 1);
    assert.deepEqual(JSON.parse(page.acknowledge(JSON.stringify({ ...ack, token: 99 }))), []);
    assert.equal(JSON.parse(page.status()).accepted, 0);
    assert.deepEqual(await exchange(request), ack);
    assert.deepEqual(JSON.parse(page.acknowledge(JSON.stringify(ack))), []);
    assert.equal(JSON.parse(page.status()).accepted, 1);
    assert.equal(text, 'a🎉\r\n');
    // Coordinate converters after an emoji: 4 display bytes are 2 UTF-16 units.
    assert.deepEqual(JSON.parse(page.display_to_utf16(1n, 1, 5)), { start: 1, end: 3 });
    assert.deepEqual(JSON.parse(page.utf16_to_display(1n, 1, 3)), { start: 1, end: 5 });
    assert.throws(() => page.utf16_to_display(1n, 2, 3), 'mid-surrogate');
    assert.throws(() => page.display_to_utf16(1n, 2, 5), 'mid-char');
    assert.throws(() => page.utf16_to_display(0n, 1, 3), 'stale revision');
    assert.deepEqual(JSON.parse(page.acknowledge(JSON.stringify(ack))), []);
    apply(await send(JSON.parse(page.undo(1n))));
    assert.equal(text, 'a\r\n');
    apply(await send(JSON.parse(page.redo(2n))));
    assert.equal(text, 'a🎉\r\n');
    const selection = JSON.parse(page.select_with_affinity(3n, 0, 5, '"Forward"'));
    assert.equal(selection.affinity, 'Forward');
    const toggle = JSON.parse(page.toggle_format(3n, '"Strike"'));
    assert.ok(page.project(4n, 0, 7));
    const rich = await send(toggle);
    apply(rich);
    assert.equal(text, 'a🎉\r\n');
    assert.equal(page.draft_text(), '~~__a🎉__~~\r\n');
    assert.equal(rich.affinity, 'Forward');
    assert.deepEqual(rich.projection.runs[0].formats, ['Bold', 'Strike']);
    assert.deepEqual(JSON.parse(page.project(4n, 0, 7)), rich.projection);
    const entity = JSON.parse(page.replace(4n, 0, 5, '&acE;'));
    apply(await send(entity));
    assert.equal(text, '∾\u0333\r\n');
    assert.equal(page.draft_text(), '~~__&acE;__~~\r\n');
    const entityProjection = JSON.parse(page.project(5n, 0, 7));
    assert.ok(
      entityProjection.correspondence.some(
        (part) =>
          part.source.start === 4 &&
          part.source.end === 9 &&
          part.display.start === 0 &&
          part.display.end === 5 &&
          part.kind === 'Replaced',
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
    const entityChange = await send(partialEntity);
    apply(entityChange);
    assert.equal(text, '∾x\r\n');
    assert.equal(page.draft_text(), '~~__&#8766;x__~~\r\n');
    assert.deepEqual(entityChange.selection, { start: 4, end: 4 });
    assert.deepEqual(entityChange.projection.runs[0].formats, ['Bold', 'Strike']);
    apply(await send(JSON.parse(page.undo(6n))));
    assert.equal(text, '∾\u0333\r\n');
    assert.equal(page.draft_text(), '~~__&acE;__~~\r\n');
    assert.deepEqual(JSON.parse(page.project(7n, 0, 7)), { ...entityProjection, revision: 7 });
    apply(await send(JSON.parse(page.redo(7n))));
    assert.equal(text, '∾x\r\n');
    assert.equal(page.draft_text(), '~~__&#8766;x__~~\r\n');
    // Composition commits and multi-run keyboard corrections are explicit,
    // isolated actions; each crosses the real store once before display.
    const commit = JSON.parse(
      page.replace_utf16_action(8n, 2, 2, new Uint16Array([0x65e5]), '"CompositionCommit"'),
    );
    assert.equal(text, '∾x\r\n');
    apply(await send(commit));
    assert.equal(page.draft_text(), '~~__&#8766;x日__~~\r\n');
    assert.equal(text, '∾x日\r\n');
    const runs = JSON.stringify([
      { range: { start: 0, end: 1 }, inserted: [0xd83d, 0xde00] },
      { range: { start: 1, end: 2 }, inserted: [0x7a] },
    ]);
    const compound = JSON.parse(page.replace_many_utf16(9n, runs));
    assert.equal(compound.request.operation.Append.previous_revision, 9);
    assert.equal(compound.request.operation.Append.revision, 10);
    assert.equal(text, '∾x日\r\n');
    apply(await send(compound));
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
    assert.equal(JSON.parse(page.status()).outstanding, 0);
    apply(await send(JSON.parse(page.undo(10n))));
    assert.equal(page.draft_text(), '~~__&#8766;x日__~~\r\n');
    apply(await send(JSON.parse(page.undo(11n))));
    assert.equal(page.draft_text(), '~~__&#8766;x__~~\r\n');
    apply(await send(JSON.parse(page.redo(12n))));
    apply(await send(JSON.parse(page.redo(13n))));
    assert.equal(page.draft_text(), '~~__😀z日__~~\r\n');
    assert.equal(text, '😀z日\r\n');
    // A resulting selection echo keeps the carried marks across a trailing
    // space, without platform-side grouping or formatting heuristics.
    page.select_with_affinity(14n, 8, 8, '"Backward"');
    apply(await send(JSON.parse(page.replace(14n, 8, 8, ' '))));
    assert.equal(page.draft_text(), '~~__😀z日__~~ \r\n');
    page.select_with_affinity(15n, 9, 9, '"Backward"');
    apply(await send(JSON.parse(page.replace(15n, 9, 9, 'b'))));
    assert.equal(page.draft_text(), '~~__😀z日 b__~~\r\n');
    assert.equal(text, '😀z日 b\r\n');
    assert.deepEqual(new Set(JSON.parse(page.active_formats())), new Set(['Bold', 'Strike']));
    // Paragraph keys use the supplied UTF-16 range despite a distant stored
    // caret, and cross the same store acknowledgement boundary as text input.
    page.select_with_affinity(16n, 0, 0, '"Forward"');
    const enter = JSON.parse(page.paragraph_key_utf16(16n, 2, 2, '"Enter"'));
    assert.equal(text, '😀z日 b\r\n');
    apply(await send(enter));
    assert.equal(text, '😀\r\nz日 b\r\n');
    assert.equal(page.draft_text(), '~~__😀\r\nz日 b__~~\r\n');
    const backspace = JSON.parse(page.paragraph_key_utf16(17n, 4, 4, '"Backspace"'));
    apply(await send(backspace));
    assert.equal(text, '😀z日 b\r\n');
    apply(await send(JSON.parse(page.undo(18n))));
    assert.equal(text, '😀\r\nz日 b\r\n');
    apply(await send(JSON.parse(page.undo(19n))));
    assert.equal(text, '😀z日 b\r\n');
    assert.equal(JSON.parse(page.paragraph_key_utf16(20n, 0, 0, '"Backspace"')), null);
    const heading = JSON.parse(page.block_command_utf16(20n, 0, 0, '{"Heading":6}'));
    assert.equal(text, '😀z日 b\r\n');
    const headingChange = await send(heading);
    apply(headingChange);
    assert.equal(headingChange.projection.blocks[0].heading, 6);
    assert.equal(page.draft_text(), '###### ~~__😀z日 b__~~\r\n');
    assert.equal(text, '😀z日 b\r\n');
    const blockEnter = JSON.parse(page.paragraph_key_utf16(21n, 3, 3, '"Enter"'));
    apply(await send(blockEnter));
    assert.equal(page.draft_text(), '###### ~~__😀z__~~\r\n~~__日 b__~~\r\n');
    assert.equal(text, '😀z\r\n日 b\r\n');
    apply(await send(JSON.parse(page.undo(22n))));
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
    apply(await send(markedCommit));
    assert.equal(text, '😀z日本 b\r\n');
    assert.equal(page.draft_text(), '###### ~~__😀z日本 b__~~\r\n');
    assert.equal(JSON.parse(page.commit_composition_utf16(24n)), null);
    for (const [revision, command, expected] of [
      [24n, '"Quote"', '> ~~__😀z日本 b__~~\r\n'],
      [25n, '"Indent"', '> > ~~__😀z日本 b__~~\r\n'],
      [26n, '"Outdent"', '> ~~__😀z日本 b__~~\r\n'],
    ]) {
      const request = JSON.parse(page.block_command_utf16(revision, 0, 0, command));
      apply(await send(request));
      assert.equal(page.draft_text(), expected);
      assert.equal(text, '😀z日本 b\r\n');
    }
    const divider = JSON.parse(page.block_command_utf16(27n, 7, 7, '"Divider"'));
    const dividerChange = await send(divider);
    apply(dividerChange);
    assert.equal(page.draft_text(), '> ~~__😀z日本 b__~~\r\n> ***\r\n> \r\n');
    assert.equal(text, '😀z日本 b\r\n\ufffc\r\n\r\n');
    assert.ok(dividerChange.projection.blocks.some((block) => block.divider));
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
    'Compiled WASM / Rust store consumer: immediate edit/undo/redo/append and block regressions passed.',
  );
  const identityVault = mkdtempSync(join(tmpdir(), 'futo-editor-wasm-identity-'));
  const identityWorker = spawn(process.argv[3], [identityVault, 'lifecycle'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const identityExited = once(identityWorker, 'exit');
  const identityDeadline = setTimeout(() => identityWorker.kill(), 30_000);
  const identityLines = createInterface({ input: identityWorker.stdout })[Symbol.asyncIterator]();
  let identityPage;
  try {
    const next = async () => {
      const line = await identityLines.next();
      assert.equal(line.done, false);
      return JSON.parse(line.value);
    };
    const exchange = async (request) => {
      identityWorker.stdin.write(JSON.stringify(request) + '\n');
      return next();
    };
    const sendIdentity = async (applied) => {
      assert.deepEqual(
        JSON.parse(identityPage.acknowledge(JSON.stringify(await exchange(applied.request)))),
        [],
      );
      return applied.change;
    };
    identityPage = WasmSession.restore(JSON.stringify(await next()));
    let view = '[[plain]]';
    const apply = (change) => {
      const bytes = Buffer.from(view);
      view = Buffer.concat([
        bytes.subarray(0, change.range.start),
        Buffer.from(change.inserted),
        bytes.subarray(change.range.end),
      ]).toString();
    };
    const input = JSON.parse(identityPage.replace(0n, 9, 9, '!'));
    apply(await sendIdentity(input));
    assert.deepEqual(await exchange({ checkpoint: true }), { id: 'plain' });
    assert.deepEqual(await exchange({ rename: 'long name' }), { id: 'long name' });
    const offer = await exchange(JSON.parse(identityPage.resume()));
    assert.ok(offer.relink);
    identityPage.acknowledge(JSON.stringify(offer));
    const adoption = JSON.parse(identityPage.apply_relink_offer());
    assert.equal(identityPage.draft_text(), '[[long name]]!');
    apply(adoption.change);
    assert.equal(view, '[[long name]]!');
    const accepted = await exchange(adoption.request);
    assert.deepEqual(await exchange(adoption.request), accepted);
    assert.deepEqual(JSON.parse(identityPage.acknowledge(JSON.stringify(accepted))), []);
    assert.deepEqual(JSON.parse(identityPage.acknowledge(JSON.stringify(accepted))), []);
    apply(await sendIdentity(JSON.parse(identityPage.undo(2n))));
    assert.equal(view, '[[plain]]!');
    apply(await sendIdentity(JSON.parse(identityPage.redo(3n))));
    assert.equal(view, '[[long name]]!');
    assert.deepEqual(await exchange({ checkpoint: true }), { id: 'long name' });
  } finally {
    clearTimeout(identityDeadline);
    identityPage?.free();
    identityWorker.stdin.end();
    const [code] = await identityExited;
    rmSync(identityVault, { recursive: true });
    assert.equal(code, 0);
  }
  console.log(
    'Compiled WASM / Rust store lifecycle: relink offer, immediate delta, duplicate ack and history passed.',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

await runMergeRegressions(WasmSession, process.argv[3]);

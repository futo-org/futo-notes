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
  const codeSource = '```\narchive\n```';
  const codeExchange = await start(codeSource);
  const literalCode = 'alpha\n```\nomega\n```';
  const fencedSource = '````\n' + literalCode + '\n````';
  const acceptCode = async (applied) => {
    const { request } = JSON.parse(applied);
    session.acknowledge(JSON.stringify(await codeExchange(JSON.stringify(request))));
  };
  await acceptCode(session.paste_markdown(0n, 0, 7, literalCode));
  assert.equal(session.draft_text(), fencedSource);
  assert.equal(
    JSON.parse(session.project(1n, 0, Buffer.byteLength(literalCode))).text,
    literalCode,
  );
  await acceptCode(session.undo(1n));
  assert.equal(session.draft_text(), codeSource);
  await acceptCode(session.redo(2n));
  assert.equal(session.draft_text(), fencedSource);
  assert.deepEqual(await codeExchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();
  await start('--reopen');
  assert.equal(session.draft_text(), savedSource(fencedSource));
  assert.equal(
    JSON.parse(session.project(0n, 0, Buffer.byteLength(literalCode))).text,
    literalCode,
  );
  await stop();
  for (const [source, text, expected] of [
    ['```\n\n```', '# h', '```\n# h\n```'],
    ['```\n\n```', literalCode, fencedSource],
  ]) {
    const emptyExchange = await start(source);
    const acceptEmpty = async (applied) => {
      const { change, request } = JSON.parse(applied);
      session.acknowledge(JSON.stringify(await emptyExchange(JSON.stringify(request))));
      return change;
    };
    const caret = Buffer.byteLength(text);
    const pasted = await acceptEmpty(session.paste_markdown(0n, 0, 0, text));
    assert.deepEqual(pasted.selection, { start: caret, end: caret });
    assert.equal(session.draft_text(), expected);
    assert.equal(JSON.parse(session.project(1n, 0, caret)).text, text);
    await acceptEmpty(session.undo(1n));
    assert.equal(session.draft_text(), source);
    await acceptEmpty(session.redo(2n));
    assert.equal(session.draft_text(), expected);
    assert.deepEqual(await emptyExchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
    await stop();
    await start('--reopen');
    assert.equal(session.draft_text(), savedSource(expected));
    assert.equal(JSON.parse(session.project(0n, 0, caret)).text, text);
    await stop();
  }
  for (const fixture of [
    // A selection starting in a block's code keeps the frame: the paste is code.
    {
      source: '```\n\n```\n\nplain\n',
      end: 8,
      text: '# h',
      expected: '```\n# h\n```',
      shown: '# h',
    },
    {
      source: '```\r\n\r\n```\r\n\r\nplain\r\n',
      end: 11,
      text: '# h\nbody',
      expected: '```\r\n# h\r\nbody\r\n```',
      shown: '# h\r\nbody',
    },
    {
      source: '```\n' + 'x\n'.repeat(2000) + '```\n\nplain\n',
      end: 4007,
      text: '# h',
      expected: '```\n# h\n```',
      shown: '# h',
    },
  ]) {
    const selectedExchange = await start(fixture.source);
    const acceptSelected = async (applied) => {
      const { change, request } = JSON.parse(applied);
      session.acknowledge(JSON.stringify(await selectedExchange(JSON.stringify(request))));
      return change;
    };
    session.select_with_affinity(0n, 0, fixture.end, JSON.stringify('Forward'));
    const caret = Buffer.byteLength(fixture.shown);
    const pasted = await acceptSelected(session.paste_markdown(0n, 0, fixture.end, fixture.text));
    assert.deepEqual(pasted.selection, { start: caret, end: caret });
    assert.equal(session.draft_text(), fixture.expected);
    assert.equal(JSON.parse(session.project(1n, 0, caret)).text, fixture.shown);
    const undone = await acceptSelected(session.undo(1n));
    assert.deepEqual(undone.selection, { start: 0, end: fixture.end });
    assert.equal(session.draft_text(), fixture.source);
    await acceptSelected(session.redo(2n));
    assert.equal(session.draft_text(), fixture.expected);
    assert.deepEqual(await selectedExchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
    await stop();
    await start('--reopen');
    assert.equal(session.draft_text(), savedSource(fixture.expected));
    assert.equal(JSON.parse(session.project(0n, 0, caret)).text, fixture.shown);
    await stop();
  }
  for (const fixture of [
    {
      source: '猫a tail',
      at: 4,
      text: "[λ](<https://x.test> 'T')",
      expected: "猫a[λ](<https://x.test> 'T') tail",
      display: '猫aλ tail',
      caret: 6,
      label: [4, 6],
      title: 'T',
    },
  ]) {
    const linkExchange = await start(fixture.source);
    const acceptLink = async (applied) => {
      const { change, request } = JSON.parse(applied);
      session.acknowledge(JSON.stringify(await linkExchange(JSON.stringify(request))));
      return change;
    };
    session.select_with_affinity(0n, fixture.at, fixture.at, JSON.stringify('Forward'));
    const pastedLink = await acceptLink(
      session.paste_markdown(0n, fixture.at, fixture.at, fixture.text),
    );
    assert.deepEqual(pastedLink.selection, { start: fixture.caret, end: fixture.caret });
    assert.equal(session.draft_text(), fixture.expected);
    const projection = JSON.parse(session.project(1n, 0, Buffer.byteLength(fixture.display)));
    assert.equal(projection.text, fixture.display);
    assert.equal(projection.links.length, 1);
    assert.deepEqual(projection.links[0].range, { start: fixture.label[0], end: fixture.label[1] });
    assert.equal(projection.links[0].destination, 'https://x.test');
    assert.equal(projection.links[0].title, fixture.title);
    const undoneLink = await acceptLink(session.undo(1n));
    assert.deepEqual(undoneLink.selection, { start: fixture.at, end: fixture.at });
    assert.equal(session.draft_text(), fixture.source);
    const redoneLink = await acceptLink(session.redo(2n));
    assert.deepEqual(redoneLink.selection, { start: fixture.caret, end: fixture.caret });
    assert.equal(session.draft_text(), fixture.expected);
    assert.deepEqual(await linkExchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
    await stop();
    await start('--reopen');
    assert.equal(session.draft_text(), savedSource(fixture.expected));
    const reopenedLink = JSON.parse(session.project(0n, fixture.label[0], fixture.label[1]));
    assert.equal(reopenedLink.links[0].destination, 'https://x.test');
    await stop();
  }
  console.log(
    'Compiled WASM clipboard: copy, one-action cut, Markdown paste, literal code fences, named-link meaning/carets/history and real store saving passed.',
  );
} finally {
  if (session) await stop();
  rmSync(vault, { recursive: true });
}

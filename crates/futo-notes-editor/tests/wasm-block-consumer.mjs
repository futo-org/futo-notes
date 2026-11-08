// Literal block commands through the compiled WASM editor and real Rust store.
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
import { setTimeout, clearTimeout } from 'node:timers';
const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);

async function blockRegression(opening, shown, converted, finalSource, finalDisplay, shortcut) {
  const vault = mkdtempSync(join(tmpdir(), 'futo-editor-wasm-blocks-'));
  const worker = spawn(process.argv[3], [vault, opening], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(worker, 'exit');
  const deadline = setTimeout(() => worker.kill(), 30_000);
  deadline.unref();
  const lines = createInterface({ input: worker.stdout })[Symbol.asyncIterator]();
  let session;
  try {
    const next = async () => {
      const line = await lines.next();
      assert.equal(line.done, false);
      return JSON.parse(line.value);
    };
    session = WasmSession.restore(JSON.stringify(await next()));
    let display = shown;
    const accept = async (applied) => {
      const { change, request } = JSON.parse(applied);
      worker.stdin.write(JSON.stringify(request) + '\n');
      session.acknowledge(JSON.stringify(await next()));
      const bytes = Buffer.from(display);
      display = Buffer.concat([
        bytes.subarray(0, change.range.start),
        Buffer.from(change.inserted),
        bytes.subarray(change.range.end),
      ]).toString();
    };
    if (shortcut) session.select_with_affinity(0n, 1, 1, '"Backward"');
    await accept(
      shortcut
        ? session.replace_utf16(0n, 1, 1, new Uint16Array([32]))
        : session.paragraph_key_utf16(0n, 2, 2, '"Enter"'),
    );
    assert.equal(session.draft_text(), converted);
    await accept(session.undo(1n));
    assert.equal(session.draft_text(), opening);
    assert.equal(display, shown);
    await accept(session.redo(2n));
    assert.equal(session.draft_text(), converted);
    if (!shortcut) {
      assert.deepEqual(JSON.parse(session.active_formats()), ['Bold']);
      await accept(session.replace_utf16(3n, 3, 3, new Uint16Array([99])));
    }
    assert.equal(session.draft_text(), finalSource);
    assert.equal(display, finalDisplay);
  } finally {
    clearTimeout(deadline);
    session?.free();
    worker.stdin.end();
    const [code] = await exited;
    rmSync(vault, { recursive: true });
    assert.equal(code, 0);
  }
}

async function reviewedBlockRegression(
  opening,
  command,
  expected,
  shown,
  caret,
  end = caret,
  finalDisplay = shown,
  followup = false,
  language,
) {
  const vault = mkdtempSync(join(tmpdir(), 'futo-editor-wasm-reviewed-blocks-'));
  const worker = spawn(process.argv[3], [vault, opening], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(worker, 'exit');
  const deadline = setTimeout(() => worker.kill(), 30_000);
  deadline.unref();
  const lines = createInterface({ input: worker.stdout })[Symbol.asyncIterator]();
  let session;
  try {
    const next = async () => {
      const line = await lines.next();
      assert.equal(line.done, false);
      return JSON.parse(line.value);
    };
    session = WasmSession.restore(JSON.stringify(await next()));
    assert.equal(JSON.parse(session.project(0n, 0, Buffer.byteLength(shown))).text, shown);
    let display = shown;
    const accept = async (applied) => {
      const { change, request } = JSON.parse(applied);
      worker.stdin.write(JSON.stringify(request) + '\n');
      session.acknowledge(JSON.stringify(await next()));
      const bytes = Buffer.from(display);
      display = Buffer.concat([
        bytes.subarray(0, change.range.start),
        Buffer.from(change.inserted),
        bytes.subarray(change.range.end),
      ]).toString();
      assert.ok(change.selection.end <= Buffer.byteLength(display));
      return change;
    };
    const change = await accept(
      ['Enter', 'KeyDelete', 'Backspace', 'Tab', 'ShiftTab'].includes(command)
        ? session.paragraph_key_utf16(
            0n,
            caret,
            end,
            JSON.stringify(command === 'KeyDelete' ? 'Delete' : command),
          )
        : ['Space', 'Newline'].includes(command)
          ? session.replace_utf16_action(
              0n,
              caret,
              end,
              new Uint16Array([command === 'Space' ? 32 : 10]),
              '"Isolated"',
            )
          : command === 'Delete'
            ? session.replace_utf16_action(0n, caret, end, new Uint16Array(), '"Isolated"')
            : session.block_command_utf16(0n, caret, end, JSON.stringify(command)),
    );
    if (language !== undefined) {
      const code = change.projection.blocks.find((block) => block.code);
      assert.ok(code);
      assert.equal(code.language, language);
    }
    if (caret === end && typeof command === 'object')
      assert.deepEqual(change.selection, { start: caret, end: caret });
    let revision = 1n;
    if (followup) {
      const at = change.selection.end;
      const units = Buffer.from(display).subarray(0, at).toString().length;
      await accept(
        session.replace_utf16_action(revision++, units, units, new Uint16Array([33]), '"Isolated"'),
      );
    }
    assert.equal(session.draft_text(), expected);
    assert.equal(display, finalDisplay);
    await accept(session.undo(revision++));
    if (followup) await accept(session.undo(revision++));
    assert.equal(session.draft_text(), opening);
    assert.equal(display, shown);
    await accept(session.redo(revision++));
    if (followup) await accept(session.redo(revision++));
    assert.equal(session.draft_text(), expected);
    assert.equal(display, finalDisplay);
  } finally {
    clearTimeout(deadline);
    session?.free();
    worker.stdin.end();
    const [code] = await exited;
    rmSync(vault, { recursive: true });
    assert.equal(code, 0);
  }
}

export async function runBlockRegressions() {
  await reviewedBlockRegression('ab', 'CodeBlock', '```\nab\n```', 'ab', 0, 0, 'ab', false, null);
  await reviewedBlockRegression(
    '~~~js\nab\n cd\n~~~',
    'Tab',
    '~~~js\na  b\n cd\n~~~',
    'ab\n cd',
    1,
    1,
    'a  b\n cd',
    false,
    'js',
  );
  await reviewedBlockRegression(
    '~~~js\nab\n cd\n~~~',
    'ShiftTab',
    '~~~js\nab\ncd\n~~~',
    'ab\n cd',
    4,
    4,
    'ab\ncd',
    false,
    'js',
  );
  await reviewedBlockRegression(
    '~~~~ c++ info\r\n猫🦊\r\n~~~~~  \r\n\n__tail__',
    'Enter',
    '~~~~ c++ info\r\n猫\r\n🦊\r\n~~~~~  \r\n\n__tail__',
    '猫🦊\r\n\ntail',
    1,
    1,
    '猫\r\n🦊\r\n\ntail',
    false,
    'c++',
  );
  await blockRegression(
    '\\#A #\r\ntail  ',
    '#A #\r\ntail  ',
    '# A \\#\r\ntail  ',
    '# A \\#\r\ntail  ',
    'A #\r\ntail  ',
    true,
  );
  await blockRegression('# __ab__', 'ab', '# __ab__\n', '# __ab__\n__c__', 'ab\nc', false);
  for (const item of [
    ['#x\n=', { Heading: 0 }, '#x', '#x', 0, 2],
    ['> x\n> y\n> =', 'Indent', '> > x\n> > y\n> > =', 'x\ny', 0, 3],
    ['> > x\r\n> > y\r\n> > ---', 'Outdent', '> x\r\n> y\r\n> ---', 'x\r\ny', 0, 4],
    [
      '> > 猫🦊\r\n> > e\u0301\r\n> > ===',
      'Enter',
      '> > 猫🦊\r\n> > ===\r\n\r\n> > e\u0301',
      '猫🦊\r\ne\u0301',
      5,
      5,
      '猫🦊\r\n\r\ne\u0301',
    ],
    ['> # x', 'Enter', '> # \n> ', 'x', 0, 1, '\n'],
    ['> x\n> =', 'Enter', '> # \n> ', 'x', 0, 1, '\n'],
    ['> x\n> =', 'Delete', '> # ', 'x', 0, 1, ''],
    ['   foo', { Heading: 2 }, '## &#32;  foo', '   foo', 6],
    ['   # foo', { Heading: 0 }, 'foo', 'foo', 0],
    ['> > ## 猫🦊 ##', 'Quote', '> ## 猫🦊 ##', '猫🦊', 0],
    ['> foo\r\n> bar\r\n> ===', { Heading: 0 }, '> foo\r\n> bar', 'foo\r\nbar', 5],
  ])
    await reviewedBlockRegression(...item);
  for (const item of [
    ['> a\n> b\n> =', 'Divider', '> ---\n> \n> a\n> b\n> =', 'a\nb', 0, 0, '\ufffc\n\na\nb', false],
    ['> a\n> b\n> =', 'Divider', '> ---\n> ', 'a\nb', 0, 3, '\ufffc\n', false],
    [
      '> 猫🦊\n> e\u0301z\n> ===',
      'Divider',
      '> 猫🦊\n> e\u0301z\n> ===\n> ***\n> ',
      '猫🦊\ne\u0301z',
      7,
      7,
      '猫🦊\ne\u0301z\n\ufffc\n',
      false,
    ],
    ['a\nb\n===', { Heading: 3 }, '### a b', 'a\nb', 0, 3, 'a b', false],
    [
      '> ab ##\n> cd ###\n> ===',
      { Heading: 3 },
      '> ### ab ## cd \\###',
      'ab ##\ncd ###',
      0,
      12,
      'ab ## cd ###',
      false,
    ],
    ['## x y', 'KeyDelete', '## &#32;y', 'x y', 0, 0, ' y', false],
    ['## # ab', 'KeyDelete', '## &#32;ab', '# ab', 0, 0, ' ab', false],
    ['#x\n=', 'Backspace', '\\#\n=', '#x', 2, 2, '#', false],
    ['## x', 'Space', '## &#32;', 'x', 0, 1, ' ', false],
    ['x\n=', 'Newline', '# \n', 'x', 0, 1, '\n', false],
    ['> __ab\n> cd__', 'Enter', '> __a__\n> __!b__\n> __cd__', 'ab\ncd', 1, 1, 'a\n!b\ncd', true],
    [
      '> __ab\n> cd__\n> ===',
      'Enter',
      '> __a__\n> ===\n> __!b\n> cd__',
      'ab\ncd',
      1,
      1,
      'a\n!b\ncd',
      true,
    ],
    ['> `ab`\n> `cd`\n> ---', 'KeyDelete', '> `ab`\n> `!d`\n> ---', 'ab\ncd', 3, 3, 'ab\n!d', true],
    [
      '> ab\ncd\n> ===',
      'Divider',
      '> a\n> ===\n> ***\n> \n> d\n> ===',
      'ab\ncd',
      1,
      4,
      'a\n\ufffc\n\nd',
      false,
    ],
    ['> ## # ab ##\n> ## cd ###', 'KeyDelete', '> ##  ! ###', '# ab\ncd', 0, 7, '!', true],
    ['> ab\n> ===', 'Space', '> # &#32;', 'ab', 0, 2, ' ', false],
  ])
    await reviewedBlockRegression(...item);
  // #300: front matter is one inert metadata block; a fence inside <pre> stays raw HTML.
  const foreign = new WasmSession(1n, '---\ntags: [a]\n---\n<pre>\n\n```\n</pre>\n', 0n);
  try {
    const shown = 'tags: [a]\n<pre>\n\n```\n</pre>\n';
    const projection = JSON.parse(foreign.project(0n, 0, Buffer.byteLength(shown)));
    assert.equal(projection.text, shown);
    assert.equal(projection.blocks[0].metadata, true);
    assert.deepEqual(projection.blocks[0].range, { start: 0, end: 9 });
    assert.ok(projection.blocks.slice(1).every((block) => !block.code && !block.metadata));
  } finally {
    foreign.free();
  }
}

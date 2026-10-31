// Distinct URI-class and split owners through compiled WASM plus real Store.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { protocolView } from './wasm-protocol-view.mjs';

export async function relinkClassConsumer(options) {
  await literalRelink(options);
  await completedSeedRelink(options);
  await partialCodeSplit(options);
}

async function literalRelink({ start, stop, getSession, createRoot, parseSource }) {
  const root = createRoot('futo-editor-wasm-relink-class-');
  let exchange = await start('', root);
  let page = getSession();
  const view = protocolView(page, exchange, '', 'URI class retirement');
  const old = 'https://x.test/[[plain]]/path';
  const renamed = 'https://x.test/[[next name]]/path';
  const end = old.length + 1;
  const code = `<\`${renamed}\`>`;
  const expected = `<${renamed}>`;
  const standard = parseSource(code);
  try {
    const proof = JSON.parse(standard.project(0n, 0, expected.length));
    assert.equal(proof.text, expected);
    assert.deepEqual(proof.links, []);
    assert.deepEqual(
      proof.runs.filter((run) => run.formats.includes('Code')).map((run) => run.range),
      [{ start: 1, end: renamed.length + 1 }],
    );
  } finally {
    standard.free();
  }
  await view.apply(page.replace(0n, 0, 0, `<${old}`));
  await view.apply(page.replace(view.revision, end, end, '>'));
  page.select_with_affinity(view.revision, 1, end, '"Backward"');
  await view.apply(page.toggle_format(view.revision, '"Code"'));
  await view.apply(page.replace_utf16_action(view.revision, end + 1, end + 1, [33], '"Isolated"'));
  await view.apply(page.undo(view.revision));
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  assert.deepEqual(await exchange(JSON.stringify({ rename: 'next name' })), { id: 'next name' });
  const offer = await exchange(page.flush());
  assert.ok(offer.relink);
  assert.equal(JSON.parse(page.acknowledge(JSON.stringify(offer))), null);
  const request = page.apply_relink_offer();
  assert.equal(page.draft_text(), code);
  await view.apply(request, true);
  assert.equal(view.text, expected);
  assert.equal(JSON.parse(page.acknowledge(JSON.stringify(offer))), null);
  await view.apply(page.redo(view.revision));
  assert.equal(page.draft_text(), `${code}!`);
  await view.apply(page.undo(view.revision));
  await view.apply(page.undo(view.revision));
  assert.equal(view.text, expected);
  assert.deepEqual(JSON.parse(page.project(view.revision, 0, expected.length)).links, []);
  const literal = parseSource(page.draft_text());
  try {
    const proof = JSON.parse(literal.project(0n, 0, expected.length));
    assert.equal(proof.text, expected);
    assert.deepEqual(proof.links, []);
  } finally {
    literal.free();
  }
  await view.apply(page.redo(view.revision));
  assert.equal(page.draft_text(), code);
  page.select_with_affinity(view.revision, 1, renamed.length + 1, '"Backward"');
  await view.apply(page.toggle_format(view.revision, '"Code"'));
  await view.apply(page.replace(view.revision, expected.length, expected.length, ' '));
  assert.equal(view.text, `${expected} `);
  assert.deepEqual(JSON.parse(page.project(view.revision, 0, view.text.length)).links, []);
  const saved = page.draft_text();
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  const revision = view.revision;
  await stop();
  exchange = await start('--reopen:next name', root);
  page = getSession();
  assert.equal(page.draft_text(), saved);
  const reopened = JSON.parse(page.project(revision, 0, view.text.length));
  assert.equal(reopened.text, view.text);
  assert.deepEqual(reopened.links, []);
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'next name' });
  await stop();
}

async function completedSeedRelink({ start, stop, getSession, createRoot, parseSource }) {
  const old = '<www.x.test/[[plain]]/path)';
  const renamed = '<www.x.test/[[next(]]/path)';
  const destination = 'http://www.x.test/[[next(]]/path)';
  const canonical = parseSource(renamed.slice(1));
  try {
    const link = JSON.parse(canonical.inspect_link(0n, 0, 1));
    assert.deepEqual(link.range, { start: 0, end: renamed.length - 1 });
    assert.equal(link.destination, destination);
  } finally {
    canonical.free();
  }
  const root = createRoot('futo-editor-wasm-relink-seed-class-');
  let exchange = await start('', root);
  let page = getSession();
  const view = protocolView(page, exchange, '', 'Typed seed URI class');
  await view.apply(page.replace(0n, 0, 0, old));
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  assert.deepEqual(await exchange(JSON.stringify({ rename: 'next(' })), { id: 'next(' });
  const offer = await exchange(page.flush());
  assert.ok(offer.relink);
  assert.equal(JSON.parse(page.acknowledge(JSON.stringify(offer))), null);
  await view.apply(page.apply_relink_offer(), true);
  assert.equal(view.text, renamed);
  assert.deepEqual(JSON.parse(page.project(view.revision, 0, renamed.length)).links, []);
  await view.apply(page.undo(view.revision));
  assert.equal(view.text, '');
  await view.apply(page.redo(view.revision));
  assert.equal(view.text, renamed);
  const end = renamed.length;
  await view.apply(page.replace(view.revision, end, end, '>'));
  assert.deepEqual(JSON.parse(page.project(view.revision, 0, end + 1)).links, []);
  page.select_with_affinity(view.revision, 0, 0, '"Forward"');
  page.select_with_affinity(view.revision, end + 1, end + 1, '"Forward"');
  await view.apply(page.replace(view.revision, end + 1, end + 1, ' '));
  assert.equal(JSON.parse(page.inspect_link(view.revision, 1, 2)).destination, destination);
  const saved = page.draft_text();
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  const revision = view.revision;
  await stop();
  exchange = await start('--reopen:next(', root);
  page = getSession();
  assert.equal(page.draft_text(), saved);
  assert.equal(JSON.parse(page.project(revision, 0, view.text.length)).text, view.text);
  assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)).destination, destination);
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'next(' });
  await stop();
}

async function partialCodeSplit({ start, stop, getSession, createRoot, parseSource }) {
  const root = createRoot('futo-editor-wasm-partial-code-split-');
  let exchange = await start('pre ', root);
  let page = getSession();
  const view = protocolView(page, exchange, 'pre ', 'Partial Code physical split');
  const expected = 'pre <https\\://x.test`/p`\n***\n\n`ath`>';
  const shown = 'pre <https://x.test/p\n\ufffc\n\nath>';
  const standard = parseSource(expected);
  try {
    const proof = JSON.parse(standard.project(0n, 0, Buffer.byteLength(shown)));
    assert.equal(proof.text, shown);
    assert.deepEqual(proof.links, []);
  } finally {
    standard.free();
  }
  await view.apply(page.replace(0n, 4, 4, '<https://x.test/path'));
  await view.apply(page.replace(view.revision, 24, 24, '>'));
  page.select_with_affinity(view.revision, 19, 24, '"Backward"');
  await view.apply(page.toggle_format(view.revision, '"Code"'));
  const guarded = page.draft_text();
  await view.apply(page.block_command_utf16(view.revision, 21, 21, '"Divider"'), true);
  assert.equal(page.draft_text(), expected);
  assert.equal(view.text, shown);
  assert.deepEqual(JSON.parse(page.project(view.revision, 0, Buffer.byteLength(shown))).links, []);
  await view.apply(page.undo(view.revision));
  assert.equal(page.draft_text(), guarded);
  await view.apply(page.redo(view.revision));
  assert.equal(page.draft_text(), expected);
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  const revision = view.revision;
  await stop();
  exchange = await start('--reopen', root);
  page = getSession();
  assert.equal(page.draft_text(), expected);
  const reopened = JSON.parse(page.project(revision, 0, Buffer.byteLength(shown)));
  assert.equal(reopened.text, shown);
  assert.deepEqual(reopened.links, []);
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();
}

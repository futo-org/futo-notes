// Public compiled WASM transport through the existing real Store worker owner.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

export async function anglePendingConsumer({
  start,
  stop,
  getSession,
  root,
  codeRoot,
  partialRoot,
}) {
  let exchange = await start('', root);
  let page = getSession();
  let shown = '';
  let revision = 0n;
  const apply = async (request) => {
    const ack = await exchange(request);
    const change = JSON.parse(page.acknowledge(JSON.stringify(ack)));
    assert.ok(change);
    const before = Buffer.from(shown);
    shown = Buffer.concat([
      before.subarray(0, change.range.start),
      Buffer.from(change.inserted),
      before.subarray(change.range.end),
    ]).toString();
    revision = BigInt(change.revision);
    assert.equal(JSON.parse(page.acknowledge(JSON.stringify(ack))), null);
    return change;
  };
  await apply(page.replace(0n, 0, 0, '<https://x.test'));
  const request = page.replace(1n, 15, 15, '>');
  assert.equal(page.draft_text(), '<<https://x.test>>');
  assert.equal(JSON.parse(page.status()).accepted, 1);
  assert.equal(shown, '<https://x.test');
  assert.throws(() => page.project(2n, 0, 16));
  const completed = await apply(request);
  assert.deepEqual(completed.selection, { start: 16, end: 16 });
  assert.equal(shown, '<https://x.test>');
  assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)), null);
  page.select_with_affinity(revision, 1, 4, '"Forward"');
  await apply(page.toggle_format(revision, '"Bold"'));
  const boldSource = '<**[htt](<https://x.test>)**[ps://x.test](<https://x.test>)>';
  assert.equal(page.draft_text(), boldSource);
  assert.equal(shown, '<https://x.test>');
  const query = JSON.parse(page.project(revision, 0, 16));
  assert.deepEqual(query.links, []);
  assert.deepEqual(
    query.runs.filter((run) => run.formats.includes('Bold')).map((run) => run.range),
    [{ start: 1, end: 4 }],
  );
  page.select_with_affinity(revision, 16, 16, '"Forward"');
  await apply(page.replace_utf16_action(revision, 16, 16, [32], '"Isolated"'));
  assert.equal(shown, '<https://x.test> ');
  assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)).destination, 'https://x.test');
  await apply(page.undo(revision));
  assert.equal(page.draft_text(), boldSource);
  assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)), null);
  await apply(page.redo(revision));
  assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)).destination, 'https://x.test');
  await apply(page.undo(revision));
  await apply(page.set_link(revision, 1, 15, 'https://new.test'));
  assert.equal(shown, '<https://x.test>');
  assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)).destination, 'https://new.test');
  await apply(page.undo(revision));
  assert.equal(page.draft_text(), boldSource);
  assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)), null);
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  await stop();
  const reopened = await start('--reopen', root);
  page = getSession();
  assert.equal(page.draft_text(), boldSource);
  assert.equal(JSON.parse(page.project(revision, 0, 16)).text, '<https://x.test>');
  assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)).destination, 'https://x.test');
  assert.deepEqual(await reopened(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();

  exchange = await start('', codeRoot);
  page = getSession();
  shown = '';
  revision = 0n;
  await apply(page.replace(0n, 0, 0, '<https://x.test'));
  await apply(page.replace(1n, 15, 15, '>'));
  page.select_with_affinity(revision, 1, 15, '"Backward"');
  await apply(page.toggle_format(revision, '"Code"'));
  const opaqueSource = '<`https://x.test`>';
  assert.equal(page.draft_text(), opaqueSource);
  assert.equal(shown, '<https://x.test>');
  const opaque = JSON.parse(page.project(revision, 0, 16));
  assert.deepEqual(opaque.links, []);
  assert.deepEqual(
    opaque.runs.filter((run) => run.formats.includes('Code')).map((run) => run.range),
    [{ start: 1, end: 15 }],
  );
  await apply(page.undo(revision));
  assert.equal(page.draft_text(), '<<https://x.test>>');
  assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)), null);
  await apply(page.redo(revision));
  assert.equal(page.draft_text(), opaqueSource);
  page.select_with_affinity(revision, 16, 16, '"Forward"');
  await apply(page.replace_utf16_action(revision, 16, 16, [32], '"Isolated"'));
  assert.deepEqual(JSON.parse(page.project(revision, 0, 17)).links, []);
  await apply(page.undo(revision));
  assert.equal(page.draft_text(), opaqueSource);
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  await stop();
  const codeReopened = await start('--reopen', codeRoot);
  page = getSession();
  assert.equal(page.draft_text(), opaqueSource);
  const reopenedCode = JSON.parse(page.project(revision, 0, 16));
  assert.equal(reopenedCode.text, '<https://x.test>');
  assert.deepEqual(reopenedCode.links, []);
  assert.deepEqual(await codeReopened(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();

  exchange = await start('', partialRoot);
  page = getSession();
  shown = '';
  revision = 0n;
  await apply(page.replace(0n, 0, 0, '<https://x.test/path'));
  await apply(page.replace(1n, 20, 20, '>'));
  page.select_with_affinity(revision, 15, 20, '"Forward"');
  await apply(page.toggle_format(revision, '"Code"'));
  assert.equal(shown, '<https://x.test/path>');
  const literal = JSON.parse(page.project(revision, 0, 21));
  assert.deepEqual(literal.links, []);
  assert.deepEqual(
    literal.runs.filter((run) => run.formats.includes('Code')).map((run) => run.range),
    [{ start: 15, end: 20 }],
  );
  assert.ok(page.draft_text().includes('\\:'));
  page.select_with_affinity(revision, 21, 21, '"Forward"');
  await apply(page.replace_utf16_action(revision, 21, 21, [32], '"Isolated"'));
  assert.deepEqual(JSON.parse(page.project(revision, 0, 22)).links, []);
  const partialSource = page.draft_text();
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  await stop();
  const partialReopened = await start('--reopen', partialRoot);
  page = getSession();
  assert.equal(page.draft_text(), partialSource);
  const loadedPartial = JSON.parse(page.project(revision, 0, 22));
  assert.equal(loadedPartial.text, '<https://x.test/path> ');
  assert.deepEqual(loadedPartial.links, []);
  assert.deepEqual(await partialReopened(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();
}

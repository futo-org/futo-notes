// Public compiled WASM transport through the existing real Store worker owner.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

export async function anglePendingConsumer({ start, stop, getSession, root }) {
  const exchange = await start('', root);
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
}

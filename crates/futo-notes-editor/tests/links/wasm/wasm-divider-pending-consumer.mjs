// Divider consumes current source fields through the existing real Store owner.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

export async function dividerPendingConsumer({ start, stop, getSession, root, referenceRoot }) {
  let exchange = await start('pre ', root);
  let page = getSession();
  let shown = 'pre ';
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
  await apply(page.replace(0n, 4, 4, '<https://x.test/path'));
  await apply(page.replace(1n, 24, 24, '>'));
  page.select_with_affinity(revision, 19, 24, '"Backward"');
  await apply(page.toggle_format(revision, '"Code"'));
  const guarded = page.draft_text();
  const request = page.block_command_utf16(revision, 4, 4, '"Divider"');
  assert.equal(JSON.parse(page.status()).accepted, 3);
  assert.equal(shown, 'pre <https://x.test/path>');
  assert.throws(() => page.project(4n, 0, 31));
  await apply(request);
  const divided = page.draft_text();
  assert.equal(shown, 'pre \n\ufffc\n\n<https://x.test/path>');
  assert.deepEqual(JSON.parse(page.project(revision, 0, 31)).links, []);
  page.select_with_affinity(revision, 25, 30, '"Backward"');
  await apply(page.toggle_format(revision, '"Code"'));
  const released = page.draft_text();
  page.select_with_affinity(revision, 31, 31, '"Forward"');
  await apply(page.replace_utf16_action(revision, 29, 29, [32], '"Isolated"'));
  assert.equal(shown, 'pre \n\ufffc\n\n<https://x.test/path> ');
  const link = JSON.parse(page.inspect_link(revision, 11, 12));
  assert.equal(link.destination, 'https://x.test/path');
  assert.deepEqual(link.range, { start: 11, end: 30 });
  await apply(page.undo(revision));
  assert.equal(page.draft_text(), released);
  await apply(page.undo(revision));
  assert.equal(page.draft_text(), divided);
  await apply(page.undo(revision));
  assert.equal(page.draft_text(), guarded);
  await apply(page.redo(revision));
  assert.equal(page.draft_text(), divided);
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  await stop();
  exchange = await start('--reopen', root);
  page = getSession();
  assert.equal(page.draft_text(), divided);
  assert.equal(JSON.parse(page.project(revision, 0, 31)).text, shown);
  page.select_with_affinity(revision, 25, 30, '"Backward"');
  await apply(page.toggle_format(revision, '"Code"'));
  await apply(page.replace_utf16_action(revision, 29, 29, [32], '"Isolated"'));
  assert.deepEqual(JSON.parse(page.project(revision, 0, 32)).links, []);
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();

  const original = "prefix [id]: /target 'T'\n\n[one][id]";
  const repaired = "prefix \n***\n\n\\[id]: /target 'T'\n\n[one][id]";
  exchange = await start(original, referenceRoot);
  page = getSession();
  shown = original;
  revision = 0n;
  page.select_with_affinity(0n, 2, 2, '"Forward"');
  const repairRequest = page.block_command_utf16(0n, 7, 7, '"Divider"');
  assert.equal(page.draft_text(), repaired);
  assert.equal(JSON.parse(page.status()).accepted, 0);
  assert.equal(shown, original);
  assert.throws(() => page.project(1n, 0, 40));
  const repairChange = await apply(repairRequest);
  assert.deepEqual(repairChange.selection, { start: 12, end: 12 });
  assert.equal(shown, "prefix \n\ufffc\n\n[id]: /target 'T'\n\n[one][id]");
  assert.deepEqual(JSON.parse(page.project(revision, 0, Buffer.byteLength(shown))).links, []);
  await apply(page.undo(revision));
  assert.equal(page.draft_text(), original);
  assert.equal(shown, original);
  await apply(page.redo(revision));
  assert.equal(page.draft_text(), repaired);
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  await stop();
  exchange = await start('--reopen', referenceRoot);
  page = getSession();
  assert.equal(page.draft_text(), repaired);
  const reopened = JSON.parse(page.project(revision, 0, Buffer.byteLength(shown)));
  assert.equal(reopened.text, shown);
  assert.deepEqual(reopened.links, []);
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();
}

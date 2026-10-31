// Exact protected input generations through compiled transport and real Store.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

export async function sourceGenerationsConsumer({ start, stop, getSession, root }) {
  const opening = '> > \n> ab\n> ===';
  const typed = '> > *ab* \n>\n> ab\n> ===';
  const headed = '> > ### *ab* \n>\n> ab\n> ===';
  let exchange = await start(opening, root);
  let page = getSession();
  let shown = '\nab';
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
  const text = new Uint16Array([42, 97, 98, 42, 32]);
  const request = page.replace_os_utf16(0n, 0, 0, text, '[]');
  assert.equal(page.draft_text(), typed);
  assert.equal(JSON.parse(page.status()).accepted, 0);
  assert.equal(shown, '\nab');
  assert.throws(() => page.project(1n, 0, 7));
  assert.deepEqual((await apply(request)).selection, { start: 3, end: 3 });
  assert.equal(shown, 'ab \n\nab');
  await apply(page.undo(revision));
  assert.equal(page.draft_text(), opening);
  await apply(page.redo(revision));
  assert.equal(page.draft_text(), typed);
  await apply(page.undo(revision));
  assert.equal(page.draft_text(), opening);
  page.compose_utf16(revision, 0, 0, text);
  const command = page.block_command_utf16(revision, 0, 5, '{"Heading":3}');
  assert.equal(page.draft_text(), headed);
  assert.equal(JSON.parse(page.status()).accepted, 4);
  assert.equal(shown, '\nab');
  assert.deepEqual((await apply(command)).selection, { start: 0, end: 3 });
  assert.equal(shown, 'ab \n\nab');
  await apply(page.undo(revision));
  assert.equal(page.draft_text(), typed);
  await apply(page.undo(revision));
  assert.equal(page.draft_text(), opening);
  await apply(page.redo(revision));
  assert.equal(page.draft_text(), typed);
  await apply(page.redo(revision));
  assert.equal(page.draft_text(), headed);
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  await stop();
  exchange = await start('--reopen', root);
  page = getSession();
  assert.equal(page.draft_text(), headed);
  assert.equal(JSON.parse(page.project(revision, 0, 7)).text, shown);
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();
}

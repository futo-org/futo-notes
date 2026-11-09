// Partial emphasis selection through compiled WASM, history, and the real store.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savedSource } from '../../wasm-saved-source.mjs';

export async function partialLink(start, stop, current, timingVaults) {
  const cases = [
    {
      source: 'Read **release notes** now',
      display: 'Read release notes now',
      from: 5,
      to: 12,
      label: 'release',
      edited: 'Read **[release](<https://x.test>) notes** now',
    },
    {
      source: 'alpha\nbeta',
      display: 'alpha\nbeta',
      from: 0,
      to: 9,
      label: 'alpha\nbet',
      edited: '[alpha\nbet](<https://x.test>)a',
    },
    {
      source: 'alpha\r\nbeta',
      display: 'alpha\r\nbeta',
      from: 0,
      to: 10,
      label: 'alpha\r\nbet',
      edited: '[alpha\r\nbet](<https://x.test>)a',
    },
  ];
  for (const { source, display, from, to, label, edited } of cases) {
    const vault = mkdtempSync(join(tmpdir(), 'futo-editor-wasm-partial-link-'));
    timingVaults.push(vault);
    const exchange = await start(source, vault);
    let session = current();
    session.select_with_affinity(0n, from, to, '\"Forward\"');
    const accept = async (request) => {
      const applied = JSON.parse(request);
      const ack = await exchange(JSON.stringify(applied.request));
      assert.deepEqual(JSON.parse(session.acknowledge(JSON.stringify(ack))), []);
      return applied.change;
    };
    await accept(session.edit_link(0n, from, to, label, 'https://x.test'));
    assert.equal(JSON.parse(session.project(1n, 0, Buffer.byteLength(display))).text, display);
    assert.equal(JSON.parse(session.inspect_link(1n, from, to)).destination, 'https://x.test');
    assert.equal(session.draft_text(), edited);
    const undo = await accept(session.undo(1n));
    assert.equal(session.draft_text(), source);
    assert.deepEqual(undo.selection, { start: from, end: to });
    await accept(session.redo(2n));
    assert.equal(session.draft_text(), edited);
    await stop();
    const reopened = await start('--reopen', vault);
    session = current();
    assert.equal(session.draft_text(), savedSource(edited));
    assert.equal(JSON.parse(session.inspect_link(0n, from, to)).destination, 'https://x.test');
    assert.deepEqual(await reopened(JSON.stringify({ checkpoint: true })), { id: 'plain' });
    await stop();
  }
}

// Partial emphasis selection through compiled WASM, history, and the real store.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savedSource } from '../../wasm-saved-source.mjs';

export async function partialLink(start, stop, current, timingVaults) {
  const partialVault = mkdtempSync(join(tmpdir(), 'futo-editor-wasm-partial-link-'));
  timingVaults.push(partialVault);
  const partialSource = 'Read **release notes** now';
  const partialDisplay = 'Read release notes now';
  const partialExchange = await start(partialSource, partialVault);
  let session = current();
  session.select_with_affinity(0n, 5, 12, '"Forward"');
  const partial = JSON.parse(session.edit_link(0n, 5, 12, 'release', 'https://x.test'));
  const partialAck = await partialExchange(JSON.stringify(partial.request));
  assert.deepEqual(JSON.parse(session.acknowledge(JSON.stringify(partialAck))), []);
  assert.equal(JSON.parse(session.project(1n, 0, 22)).text, partialDisplay);
  assert.equal(JSON.parse(session.inspect_link(1n, 5, 12)).destination, 'https://x.test');
  const partialEdited = session.draft_text();
  assert.equal(partialEdited, 'Read **[release](<https://x.test>) notes** now');
  const partialUndo = JSON.parse(session.undo(1n));
  const partialUndoAck = await partialExchange(JSON.stringify(partialUndo.request));
  assert.deepEqual(JSON.parse(session.acknowledge(JSON.stringify(partialUndoAck))), []);
  assert.equal(session.draft_text(), partialSource);
  assert.deepEqual(partialUndo.change.selection, { start: 5, end: 12 });
  const partialRedo = JSON.parse(session.redo(2n));
  const partialRedoAck = await partialExchange(JSON.stringify(partialRedo.request));
  assert.deepEqual(JSON.parse(session.acknowledge(JSON.stringify(partialRedoAck))), []);
  await stop();
  const partialReopened = await start('--reopen', partialVault);
  session = current();
  assert.equal(session.draft_text(), savedSource(partialEdited));
  assert.equal(JSON.parse(session.inspect_link(0n, 5, 12)).destination, 'https://x.test');
  assert.deepEqual(await partialReopened(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();
}

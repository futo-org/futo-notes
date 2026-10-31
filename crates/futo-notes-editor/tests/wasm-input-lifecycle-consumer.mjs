// Common typed input through compiled WASM and actual Store acknowledgement.
import assert from 'node:assert/strict';
import { protocolView } from './wasm-protocol-view.mjs';

export async function inputLifecycleConsumer({ start, stop, getSession, createRoot, parseSource }) {
  const foreign = '<[www.x.test/path](<http://www.x.test/path>)>\n\n';
  const foreignView = '<www.x.test/path>\n\n';
  const word = '<www.x.test/';
  const mixed = 'prefix <www.x.test/path> ';
  const expectedText = foreignView + word + mixed;
  const canonical = parseSource(
    foreign + word + 'prefix <[www.x.test/path](<http://www.x.test/path>)> ',
  );
  let expected;
  try {
    const projected = JSON.parse(canonical.project(0n, 0, expectedText.length));
    assert.equal(projected.text, expectedText);
    expected = projected.links;
    assert.equal(expected.length, 2);
    assert.equal(expected[0].destination, expected[1].destination);
  } finally {
    canonical.free();
  }
  const root = createRoot('futo-editor-wasm-input-lifecycle-');
  let exchange = await start(foreign, root);
  let page = getSession();
  const view = protocolView(page, exchange, foreignView, 'typed input lifecycle');
  const at = foreignView.length + word.length;
  const mark = () => {
    page.select_with_affinity(view.revision, at, at, '"Backward"');
    const marked = JSON.parse(
      page.compose_utf16(
        view.revision,
        foreignView.length + 1,
        foreignView.length + 2,
        new Uint16Array([0x77]),
      ),
    );
    assert.equal(marked.text, 'w');
    assert.deepEqual(JSON.parse(page.composition()), marked);
    assert.equal(page.draft_text(), foreign + word);
  };
  await view.apply(page.replace(0n, foreignView.length, foreignView.length, word));
  mark();
  await view.apply(page.replace(view.revision, at, at, mixed), true);
  assert.equal(view.text, expectedText);
  assert.equal(JSON.parse(page.composition()), null);
  assert.deepEqual(JSON.parse(page.project(view.revision, 0, view.text.length)).links, expected);
  const saved = page.draft_text();
  assert.ok(saved.startsWith(foreign));
  await view.apply(page.undo(view.revision), true);
  assert.equal(page.draft_text(), foreign + word);
  assert.equal(JSON.parse(page.project(view.revision, 0, view.text.length)).links.length, 1);
  await view.apply(page.redo(view.revision), true);
  assert.equal(page.draft_text(), saved);
  await view.apply(page.undo(view.revision));
  // Observe the Undo-restored source identity through actual subsequent input.
  await view.apply(page.replace(view.revision, at, at, '>'));
  const pending = parseSource(page.draft_text());
  try {
    assert.equal(
      JSON.parse(pending.inspect_link(0n, foreignView.length + 1, foreignView.length + 2))
        .destination,
      'http://www.x.test/',
    );
  } finally {
    pending.free();
  }
  page.select_with_affinity(view.revision, 0, 0, '"Forward"');
  page.select_with_affinity(view.revision, at + 1, at + 1, '"Forward"');
  await view.apply(page.replace(view.revision, at + 1, at + 1, ' '));
  assert.equal(
    JSON.parse(page.inspect_link(view.revision, foreignView.length + 1, foreignView.length + 2))
      .destination,
    'http://www.x.test/',
  );
  await view.apply(page.undo(view.revision));
  await view.apply(page.undo(view.revision));
  assert.equal(page.draft_text(), foreign + word);
  mark();
  await view.apply(page.replace(view.revision, at, at, mixed));
  assert.equal(page.draft_text(), saved);
  await view.apply(page.undo(view.revision));
  await view.apply(page.undo(view.revision));
  assert.equal(page.draft_text(), foreign);
  assert.equal(JSON.parse(page.undo(view.revision)), null);
  await view.apply(page.redo(view.revision));
  await view.apply(page.redo(view.revision));
  assert.equal(page.draft_text(), saved);
  assert.equal(JSON.parse(page.redo(view.revision)), null);
  assert.deepEqual(JSON.parse(page.project(view.revision, 0, expectedText.length)).links, expected);
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  await stop();
  exchange = await start('--reopen:plain', root);
  page = getSession();
  assert.equal(page.draft_text(), saved);
  const recovered = JSON.parse(page.project(view.revision, 0, expectedText.length));
  assert.equal(recovered.text, expectedText);
  assert.deepEqual(recovered.links, expected);
  assert.equal(JSON.parse(page.undo(view.revision)), null);
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();
  await completedHttpConsumer({ start, stop, getSession, createRoot, parseSource });
}

// A completed committed capsule never needs an unfinished Typing origin.
async function completedHttpConsumer({ start, stop, getSession, createRoot, parseSource }) {
  const foreign = '<[WwW.x.test/PaTh](<http://WwW.x.test/PaTh>)>\n\n';
  const foreignView = '<WwW.x.test/PaTh>\n\n';
  const input = '<HTTPS://x.test/PaTh> ';
  const text = foreignView + input;
  const standard = parseSource(foreign + '<<HTTPS://x.test/PaTh>> ');
  let expected;
  try {
    const canonical = JSON.parse(standard.project(0n, 0, text.length));
    assert.equal(canonical.text, text);
    expected = canonical.links;
    assert.equal(expected.length, 2);
    assert.equal(expected[0].destination, 'http://WwW.x.test/PaTh');
    assert.equal(expected[1].destination, 'HTTPS://x.test/PaTh');
  } finally {
    standard.free();
  }
  const root = createRoot('futo-editor-wasm-completed-http-');
  let exchange = await start(foreign, root);
  let page = getSession();
  const view = protocolView(page, exchange, foreignView, 'completed HTTP composition');
  const at = foreignView.length;
  const marked = JSON.parse(
    page.compose_utf16(
      view.revision,
      at,
      at,
      new Uint16Array(Array.from(input, (ch) => ch.charCodeAt(0))),
    ),
  );
  assert.equal(marked.text, input);
  assert.equal(page.draft_text(), foreign);
  assert.deepEqual(JSON.parse(page.composition()), marked);
  await view.apply(page.commit_composition_utf16(view.revision, null), true);
  assert.equal(JSON.parse(page.composition()), null);
  assert.equal(view.text, text);
  assert.deepEqual(JSON.parse(page.project(view.revision, 0, text.length)).links, expected);
  const saved = page.draft_text();
  assert.ok(saved.startsWith(foreign));
  const fresh = parseSource(saved);
  try {
    const projected = JSON.parse(fresh.project(0n, 0, text.length));
    assert.equal(projected.text, text);
    assert.deepEqual(projected.links, expected);
  } finally {
    fresh.free();
  }
  await view.apply(page.undo(view.revision), true);
  assert.equal(page.draft_text(), foreign);
  assert.equal(view.text, foreignView);
  await view.apply(page.redo(view.revision), true);
  assert.equal(page.draft_text(), saved);
  assert.equal(view.text, text);
  assert.equal(JSON.parse(page.redo(view.revision)), null);
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  await stop();
  exchange = await start('--reopen:plain', root);
  page = getSession();
  assert.equal(page.draft_text(), saved);
  const recovered = JSON.parse(page.project(view.revision, 0, text.length));
  assert.equal(recovered.text, text);
  assert.deepEqual(recovered.links, expected);
  assert.equal(JSON.parse(page.composition()), null);
  assert.equal(JSON.parse(page.undo(view.revision)), null);
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();
}

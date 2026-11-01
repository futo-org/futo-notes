// Image atoms and claimed insertion through compiled WASM.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);

const page = new WasmSession(1n, 'a ![x](image-1.png) b', 0n, 0n);
const [atom] = JSON.parse(page.project(0n, 0, 21)).atoms;
assert.equal(atom.kind, 'Image');
assert.deepEqual(atom.range, { start: 2, end: 19 });
assert.equal(atom.before, 2);
assert.equal(atom.after, 19);
assert.deepEqual(atom.image, {
  alt: 'x',
  destination: 'image-1.png',
  title: null,
  reference: null,
  vault: true,
});

const claim = page.image_claim();
page.select_with_affinity(0n, 21, 21, '"Forward"');
assert.throws(() => page.insert_image(0n, claim + 1n, 'image-2.png', ''));
assert.throws(() => page.insert_image(0n, claim, 'https://x.test/a.png', ''));
const request = JSON.parse(page.insert_image(0n, claim, 'image-2.png', ''));
assert.equal(request.operation.Append.inserted, '![](image-2.png)');
assert.throws(() => page.insert_image(0n, claim, 'image-3.png', ''));
page.free();
console.log('Compiled WASM images: atom roles and claimed insertion passed.');

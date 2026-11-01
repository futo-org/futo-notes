// Find through compiled WASM: query, step, off-path scan round trip, stale rejection.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);
const page = new WasmSession(1n, 'a **bo**ld Bold\n\nBOLD', 0n, 0n);
const send = (json) => JSON.parse(json);

let report = send(page.find_set_query(0n, 'bold'));
assert.equal(report.total, 3);
assert.equal(report.current, 1);
assert.deepEqual(report.reveal, { start: 2, end: 6 });
assert.equal(send(page.find_step(0n, true)).current, 2);
assert.equal(send(page.find_step(0n, true)).current, 3);
assert.equal(send(page.find_step(0n, true)).current, 1);
assert.equal(send(page.find_step(0n, false)).current, 3);
assert.equal(send(page.find_matches(0n, 0, 6)).length, 1);

const request = page.find_scan_request();
const result = WasmSession.find_scan(request);
const applied = send(page.find_apply_scan(result));
assert.equal(applied.total, 3);
assert.equal(applied.stale, false);

// A scan for an earlier query generation is rejected.
page.find_set_query(0n, 'b');
assert.equal(send(page.find_apply_scan(result)), null);

// Input awaiting acknowledgement keeps find from reporting an unseen revision.
page.replace(0n, 0, 0, 'x');
assert.throws(() => page.find_report());
assert.equal(send(page.find_close()).open, false);
console.log('wasm find consumer ok');

// The core's list commands through the compiled WASM editor and the real Rust
// store: every literal case in `fixtures/engine/lists/`, its saved bytes, Undo
// and Redo.
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { fixtureCases, replay } from './wasm-fixture-replay.mjs';
const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);

let count = 0;
for (const file of ['enter', 'indent', 'toggles', 'backspace-delete', 'typed']) {
  const cases = fixtureCases(`lists/${file}.json`);
  await replay(WasmSession, process.argv[3], cases, ['‸', '«', '»']);
  count += cases.length;
}
console.log(`List WASM/store cases passed: ${count}`);

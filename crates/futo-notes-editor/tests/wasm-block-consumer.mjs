// The core's block, fence and line-break commands through the compiled WASM
// editor and the real Rust store: every literal case in `fixtures/engine/`
// (blocks, fences, plain Enter), its saved bytes, Undo and Redo.
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { fixtureCases, replay } from './wasm-fixture-replay.mjs';
const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);

export async function runBlockRegressions() {
  for (const file of ['blocks.json', 'fences.json', 'clipboard/plain-enter.json']) {
    await replay(WasmSession, process.argv[3], fixtureCases(file), ['|', '[', ']']);
  }
}

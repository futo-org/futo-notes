/* For tests: Node cannot fetch the WASM the page's loader (engine.ts) asks for, so the
 * built engine is handed its bytes from disk before any `Engine.restore`. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface EngineBuild {
  initSync(options: { module: Uint8Array }): unknown;
}

export async function loadEngineBuild(): Promise<void> {
  const builds = import.meta.glob<EngineBuild>('../wasm/futo_notes_editor.js');
  const load = builds['../wasm/futo_notes_editor.js'];
  if (!load) throw new Error('editor engine not built: run node scripts/build-editor-wasm.mjs');
  const wasm = resolve(import.meta.dirname, '../wasm/futo_notes_editor_bg.wasm');
  (await load()).initSync({ module: readFileSync(wasm) });
}

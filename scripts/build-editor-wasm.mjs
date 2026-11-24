// Build the editor engine for the desktop page: a release wasm32 build of
// futo-notes-editor and wasm-bindgen's `web` bindings, written to the gitignored
// src/features/editor/desktop/wasm/ that the desktop editor loads, and the desktop
// editor's vitest tests load (`just check` and `test:full` run this first).
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { editorWasmTools, runIn } from './lib/editor-wasm.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { target, cli } = editorWasmTools(root);
runIn(root, 'cargo', [
  'build',
  '--locked',
  '--release',
  '-p',
  'futo-notes-editor',
  '--target',
  'wasm32-unknown-unknown',
]);
const built = join(target, 'wasm32-unknown-unknown/release/futo_notes_editor.wasm');
const output = join(root, 'src/features/editor/desktop/wasm');
const bindings = join(output, 'futo_notes_editor_bg.wasm');
// Bindings newer than the engine are current: rewriting them would reload a running dev app.
if (!existsSync(bindings) || statSync(bindings).mtimeMs < statSync(built).mtimeMs) {
  runIn(root, cli, ['--target', 'web', '--out-dir', output, built]);
}

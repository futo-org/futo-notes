// Build the real WASM session, generate Node bindings with the lockfile's exact
// wasm-bindgen CLI, and exchange ordered edits with the actual Rust store worker.
// Installs the wasm target and a task-local CLI only when absent; all generated
// output stays beneath Cargo's target directory. No shipping renderer is changed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { editorWasmTools, runIn } from './lib/editor-wasm.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const run = (command, args) => runIn(root, command, args);
const { target, cli } = editorWasmTools(root);
run('cargo', [
  'build',
  '--locked',
  '-p',
  'futo-notes-editor',
  '--features',
  'test-clock',
  '--target',
  'wasm32-unknown-unknown',
]);
run('cargo', ['build', '--locked', '-p', 'futo-notes-store', '--example', 'portable_host']);
const output = join(target, 'editor-wasm');
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'package.json'), '{"type":"commonjs"}\n');
run(cli, [
  '--target',
  'nodejs',
  '--out-dir',
  output,
  join(target, 'wasm32-unknown-unknown/debug/futo_notes_editor.wasm'),
]);
run(process.execPath, [
  join(root, 'crates/futo-notes-editor/tests/wasm-consumer.mjs'),
  join(output, 'futo_notes_editor.js'),
  join(target, 'debug/examples/portable_host'),
]);

run(process.execPath, [
  join(root, 'crates/futo-notes-editor/tests/wasm-native-input.mjs'),
  join(output, 'futo_notes_editor.js'),
  join(target, 'debug/examples/portable_host'),
]);

run(process.execPath, [
  join(root, 'crates/futo-notes-editor/tests/links/wasm/wasm-link-consumer.mjs'),
  join(output, 'futo_notes_editor.js'),
  join(target, 'debug/examples/portable_host'),
]);

run(process.execPath, [
  join(root, 'crates/futo-notes-editor/tests/clipboard/wasm-clipboard-consumer.mjs'),
  join(output, 'futo_notes_editor.js'),
  join(target, 'debug/examples/portable_host'),
]);

run(process.execPath, [
  join(root, 'crates/futo-notes-editor/tests/wasm-list-consumer.mjs'),
  join(output, 'futo_notes_editor.js'),
  join(target, 'debug/examples/portable_host'),
]);

run(process.execPath, [
  join(root, 'crates/futo-notes-editor/tests/find/wasm-find-consumer.mjs'),
  join(output, 'futo_notes_editor.js'),
]);

run(process.execPath, [
  join(root, 'crates/futo-notes-editor/tests/wasm-wikilink-consumer.mjs'),
  join(output, 'futo_notes_editor.js'),
]);

run(process.execPath, [
  join(root, 'crates/futo-notes-editor/tests/wasm-image-consumer.mjs'),
  join(output, 'futo_notes_editor.js'),
]);

run(process.execPath, [
  join(root, 'crates/futo-notes-editor/tests/wasm-table-consumer.mjs'),
  join(output, 'futo_notes_editor.js'),
]);

run(process.execPath, [
  join(root, 'crates/futo-notes-editor/tests/wasm-payload-shapes.mjs'),
  join(output, 'futo_notes_editor.js'),
]);

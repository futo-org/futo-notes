// Build the real WASM session, generate Node bindings with the lockfile's exact
// wasm-bindgen CLI, and exchange ordered edits with the actual Rust store worker.
// Installs the wasm target and a task-local CLI only when absent; all generated
// output stays beneath Cargo's target directory. No shipping renderer is changed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr ?? result.error ?? result.status}`,
    );
  }
  return result.stdout?.trim();
}
const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
const version = lock.match(/name = "wasm-bindgen"\nversion = "([^"]+)"/)?.[1];
if (!version) throw new Error('Cargo.lock must contain wasm-bindgen');
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? 'target');
const installed = run('rustup', ['target', 'list', '--installed'], true);
if (!installed.split('\n').includes('wasm32-unknown-unknown')) {
  run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
}
let cli = process.env.WASM_BINDGEN ?? 'wasm-bindgen';
const matches = (command) => {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() === `wasm-bindgen ${version}`;
};
if (!matches(cli)) {
  if (process.env.WASM_BINDGEN) throw new Error(`WASM_BINDGEN must be version ${version}`);
  const installRoot = join(target, 'editor-wasm-tools');
  cli = join(installRoot, 'bin', 'wasm-bindgen');
  if (!matches(cli)) {
    run('cargo', [
      'install',
      'wasm-bindgen-cli',
      '--version',
      version,
      '--locked',
      '--root',
      installRoot,
    ]);
  }
}
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

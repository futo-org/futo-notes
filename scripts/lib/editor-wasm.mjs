// The editor engine's wasm32 target and the lockfile's exact wasm-bindgen CLI, shared by
// the WASM tests and the desktop page build. Both are installed only when absent; the CLI
// lives beneath Cargo's target directory.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

export function runIn(root, command, args, capture = false) {
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

export function lockedWasmBindgenVersion(lock) {
  // \r?\n: a Windows checkout (git's autocrlf) has CRLF line endings.
  const version = lock.match(/name = "wasm-bindgen"\r?\nversion = "([^"]+)"/)?.[1];
  if (!version) throw new Error('Cargo.lock must contain wasm-bindgen');
  return version;
}

export function editorWasmTools(root) {
  const version = lockedWasmBindgenVersion(readFileSync(join(root, 'Cargo.lock'), 'utf8'));
  const target = resolve(root, process.env.CARGO_TARGET_DIR ?? 'target');
  const installed = runIn(root, 'rustup', ['target', 'list', '--installed'], true);
  if (!installed.split(/\r?\n/).includes('wasm32-unknown-unknown')) {
    runIn(root, 'rustup', ['target', 'add', 'wasm32-unknown-unknown']);
  }
  let cli = process.env.WASM_BINDGEN ?? 'wasm-bindgen';
  const matches = (command) => {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
    return result.status === 0 && result.stdout.trim() === `wasm-bindgen ${version}`;
  };
  if (!matches(cli)) {
    const installRoot = join(target, 'editor-wasm-tools');
    cli = join(installRoot, 'bin', 'wasm-bindgen');
    if (!matches(cli)) {
      runIn(root, 'cargo', [
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
  return { target, cli };
}

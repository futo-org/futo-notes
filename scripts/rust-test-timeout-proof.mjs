#!/usr/bin/env node
// Real negative proof for the sync nextest policy. The fixture cannot finish;
// this command succeeds only if nextest fails with its exact name as TIMEOUT.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureNextest } from './rust-tests.mjs';

function runTimeoutProof() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const binary = ensureNextest(root);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-sync-timeout-proof-'));
  try {
    fs.mkdirSync(path.join(scratch, 'src'));
    fs.writeFileSync(
      path.join(scratch, 'Cargo.toml'),
      '[package]\nname="futo-notes-sync"\nversion="0.0.0"\nedition="2021"\n',
    );
    fs.writeFileSync(
      path.join(scratch, 'src/lib.rs'),
      '#[test]\nfn healthy_sibling() {}\n#[test]\nfn seeded_sync_deadlock_waits_forever() { loop { std::thread::park(); } }\n',
    );
    const result = spawnSync(
      binary,
      [
        'nextest',
        'run',
        '--manifest-path',
        path.join(scratch, 'Cargo.toml'),
        '--config-file',
        path.join(root, '.config/nextest.toml'),
        '--profile=sync',
        '--no-tests=fail',
        '--no-fail-fast',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 180000,
        // This scratch crate owns its disposable build output; never clean a shared target/.
        env: { ...process.env, CARGO_TARGET_DIR: path.join(scratch, 'target') },
      },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    process.stdout.write(output);
    if (
      result.error ||
      result.status === 0 ||
      !/TIMEOUT[^\n]*seeded_sync_deadlock_waits_forever/.test(output) ||
      !/PASS[^\n]*healthy_sibling/.test(output)
    ) {
      throw new Error(
        'timeout proof failed: expected a named TIMEOUT, a healthy sibling PASS, and a nonzero test exit',
      );
    }
    console.log('Sync timeout negative proof PASS: named deadlock failed; healthy sibling passed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log('usage: just test-sync-timeout-proof');
  else if (args.length) {
    console.error('usage: just test-sync-timeout-proof');
    process.exitCode = 1;
  } else {
    try {
      runTimeoutProof();
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

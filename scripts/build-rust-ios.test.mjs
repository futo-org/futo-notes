import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const scratch = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('iOS build host preflight', () => {
  it('refuses a non-macOS host before invoking Cargo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-build-host-'));
    scratch.push(dir);
    const cargoMarker = path.join(dir, 'cargo-was-run');
    const uname = path.join(dir, 'uname');
    const cargo = path.join(dir, 'cargo');
    fs.writeFileSync(uname, '#!/bin/sh\nprintf Linux\n', { mode: 0o755 });
    fs.writeFileSync(cargo, `#!/bin/sh\nprintf called > '${cargoMarker}'\n`, { mode: 0o755 });

    const result = spawnSync('bash', ['scripts/build-rust-ios.sh'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('iOS builds require macOS');
    expect(fs.existsSync(cargoMarker)).toBe(false);
  });

  it('rejects inadequate target-volume space before invoking Cargo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-build-storage-'));
    scratch.push(dir);
    fs.mkdirSync(path.join(dir, 'scripts'));
    for (const file of ['build-rust-ios.sh', 'ios-build-space.mjs']) {
      fs.copyFileSync(path.join(root, 'scripts', file), path.join(dir, 'scripts', file));
    }
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const marker = path.join(dir, 'cargo-was-run');
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\nprintf Darwin\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'cargo'), `#!/bin/sh\nprintf called > '${marker}'\n`, {
      mode: 0o755,
    });
    const result = spawnSync('bash', ['scripts/build-rust-ios.sh'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        CARGO_TARGET_DIR: path.join(dir, 'future-target'),
        FUTO_IOS_MIN_FREE_GIB: '999999',
      },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('iOS build storage');
    expect(result.stderr).toContain('just wt gc --sizes');
    expect(fs.existsSync(marker)).toBe(false);
  });
});

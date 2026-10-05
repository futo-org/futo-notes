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
});

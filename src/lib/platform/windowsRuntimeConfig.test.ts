import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC_TAURI = resolve(ROOT, 'apps/tauri/src-tauri');

describe('Windows binary statically links the MSVC runtime', () => {
  const cargoConfig = readFileSync(resolve(SRC_TAURI, '.cargo/config.toml'), 'utf8');

  it('sets +crt-static for the x86_64-pc-windows-msvc target', () => {
    const targetIdx = cargoConfig.indexOf('[target.x86_64-pc-windows-msvc]');
    expect(targetIdx, 'missing [target.x86_64-pc-windows-msvc] table').toBeGreaterThan(-1);
    const afterTarget = cargoConfig.slice(targetIdx);
    expect(afterTarget).toMatch(/rustflags\s*=\s*\[[^\]]*target-feature=\+crt-static/);
  });
});

describe('tauri.windows.conf.json carries no stale VC++ redist workaround', () => {
  const raw = readFileSync(resolve(SRC_TAURI, 'tauri.windows.conf.json'), 'utf8');
  const conf = JSON.parse(raw);

  it('does not bundle vc_redist (superseded by static linking)', () => {
    expect(raw).not.toContain('vc_redist');
  });

  it('references no NSIS installerHooks file that does not exist', () => {
    const hooks = conf.bundle?.windows?.nsis?.installerHooks;
    if (hooks) {
      expect(existsSync(resolve(SRC_TAURI, hooks)), `installerHooks file missing: ${hooks}`).toBe(
        true,
      );
    }
  });
});

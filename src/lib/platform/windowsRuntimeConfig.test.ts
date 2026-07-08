import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Static conformance guard for the Windows runtime story.
 *
 * A clean Windows install ships neither the VC++ runtime (VCRUNTIME140.dll /
 * MSVCP140_1.dll) nor — historically — guaranteed WebView2. FUTO Notes shipped
 * builds (v1.5.1–v1.5.2, and an unverified bundle workaround after) that died on
 * first launch on clean machines with "MSVCP140_1.dll was not found". The fix is
 * to STATICALLY link the MSVC runtime into the binary (`+crt-static`) instead of
 * bundling a redistributable and hoping an NSIS hook installs it.
 *
 * These assertions fail CI if that flag is dropped, or if the removed
 * bundle/hook workaround creeps back in (which would re-introduce a dangling
 * NSIS hook reference once the .nsh file is gone). The binary-level proof — that
 * `+crt-static` actually took effect — lives in ci/win-build.ps1 (dumpbin).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC_TAURI = resolve(ROOT, 'apps/tauri/src-tauri');

describe('Windows binary statically links the MSVC runtime', () => {
  const cargoConfig = readFileSync(resolve(SRC_TAURI, '.cargo/config.toml'), 'utf8');

  it('sets +crt-static for the x86_64-pc-windows-msvc target', () => {
    const targetIdx = cargoConfig.indexOf('[target.x86_64-pc-windows-msvc]');
    expect(targetIdx, 'missing [target.x86_64-pc-windows-msvc] table').toBeGreaterThan(-1);
    // crt-static must belong to the windows-msvc target's rustflags, i.e. appear
    // after that table header (no later table re-scopes it away).
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

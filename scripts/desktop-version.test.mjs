import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readDesktopVersions,
  restoreDesktopVersions,
  setDesktopVersion,
  setTauriCargoVersion,
} from './desktop-version.mjs';

let tmp;

function fixture() {
  tmp = mkdtempSync(join(tmpdir(), 'futo-desktop-version-'));
  const confPath = join(tmp, 'tauri.conf.json');
  const cargoPath = join(tmp, 'Cargo.toml');
  writeFileSync(
    confPath,
    JSON.stringify(
      {
        productName: 'FUTO Notes',
        version: '0.1.0',
        identifier: 'com.futo.notes',
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    cargoPath,
    `[package]
name = "futo-notes-tauri"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2.0.2", features = [] }

[dependencies]
tauri = { version = "2.9.1", features = ["protocol-asset"] }
`,
  );
  return { confPath, cargoPath };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('desktop release version stamping', () => {
  it('stamps tauri.conf.json and the Tauri Cargo package version together', () => {
    const paths = fixture();

    expect(readDesktopVersions(paths)).toEqual({
      tauriConfig: '0.1.0',
      cargoPackage: '0.1.0',
    });
    expect(setDesktopVersion('1.6.0', paths)).toEqual({
      tauriConfig: true,
      cargoPackage: true,
    });
    expect(readDesktopVersions(paths)).toEqual({
      tauriConfig: '1.6.0',
      cargoPackage: '1.6.0',
    });
  });

  it('does not rewrite dependency versions in Cargo.toml', () => {
    const paths = fixture();

    setTauriCargoVersion('1.6.0', paths.cargoPath);
    const cargo = readFileSync(paths.cargoPath, 'utf8');

    expect(cargo).toContain('[package]\nname = "futo-notes-tauri"\nversion = "1.6.0"');
    expect(cargo).toContain('tauri-build = { version = "2.0.2", features = [] }');
    expect(cargo).toContain('tauri = { version = "2.9.1", features = ["protocol-asset"] }');
  });

  it('restores both original version sources exactly', () => {
    const paths = fixture();
    const original = readDesktopVersions(paths);

    setDesktopVersion('2.0.0', paths);
    restoreDesktopVersions(original, paths);

    expect(readDesktopVersions(paths)).toEqual(original);
  });

  it('rejects non-semver versions', () => {
    const paths = fixture();
    expect(() => setDesktopVersion('v1.6.0', paths)).toThrow(/invalid desktop version/);
  });
});

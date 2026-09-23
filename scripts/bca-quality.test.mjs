import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BCA_VERSION,
  SHA256_BY_TARGET,
  downloadUrl,
  tarballName,
  targetFor,
} from './bca-quality.mjs';

const ROOT = join(import.meta.dirname, '..');

describe('bca-quality target selection', () => {
  it('maps the CI platform (linux x64) and the dev platform (darwin arm64)', () => {
    expect(targetFor('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
    expect(targetFor('darwin', 'arm64')).toBe('aarch64-apple-darwin');
  });

  it('refuses unsupported platforms instead of guessing a tarball', () => {
    expect(() => targetFor('win32', 'x64')).toThrow(/BCA_BIN/);
    expect(() => targetFor('linux', 'arm64')).toThrow();
  });
});

describe('bca-quality release pin', () => {
  it('names assets with the pinned version and target', () => {
    const target = 'x86_64-unknown-linux-gnu';
    expect(tarballName(BCA_VERSION, target)).toBe(
      `big-code-analysis-${BCA_VERSION}-${target}.tar.gz`,
    );
    expect(downloadUrl(BCA_VERSION, target)).toBe(
      `https://github.com/dekobon/big-code-analysis/releases/download/v${BCA_VERSION}/big-code-analysis-${BCA_VERSION}-${target}.tar.gz`,
    );
  });

  it('carries a 64-hex sha256 for every target it can install', () => {
    expect(Object.keys(SHA256_BY_TARGET).length).toBeGreaterThan(0);
    for (const [target, sha] of Object.entries(SHA256_BY_TARGET)) {
      expect(sha, target).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('pins a release for the current platform', () => {
    const target = targetFor(process.platform, process.arch);
    expect(SHA256_BY_TARGET[target]).toBeDefined();
  });
});

describe('bca-quality committed manifest', () => {
  it('ships a baseline anchored at the repo root that the manifest names', () => {
    const manifest = readFileSync(join(ROOT, 'bca.toml'), 'utf8');
    expect(manifest).toMatch(
      /baseline = "\.\/\.bca-baseline\.toml"|baseline = "\.bca-baseline\.toml"/,
    );
    expect(existsSync(join(ROOT, '.bca-baseline.toml'))).toBe(true);
  });
});

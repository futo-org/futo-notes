import { describe, expect, it } from 'vitest';
import { lockedWasmBindgenVersion } from './editor-wasm.mjs';

const LOCK = [
  '[[package]]',
  'name = "wasm-bindgen"',
  'version = "0.2.129"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  '',
  '[[package]]',
  'name = "wasm-bindgen-macro"',
  'version = "0.2.129"',
  '',
].join('\n');

describe('lockedWasmBindgenVersion', () => {
  it('reads the version from an LF lockfile', () => {
    expect(lockedWasmBindgenVersion(LOCK)).toBe('0.2.129');
  });

  // A plain `git clone` on Git for Windows checks out core.autocrlf=true: CRLF.
  it('reads the version from a CRLF lockfile', () => {
    expect(lockedWasmBindgenVersion(LOCK.replaceAll('\n', '\r\n'))).toBe('0.2.129');
  });

  it('ignores sibling wasm-bindgen-* packages', () => {
    expect(() =>
      lockedWasmBindgenVersion(LOCK.replace('"wasm-bindgen"', '"wasm-bindgen-x"')),
    ).toThrow('Cargo.lock must contain wasm-bindgen');
  });
});

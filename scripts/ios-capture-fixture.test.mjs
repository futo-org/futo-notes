import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { sourceProvenance } from './ios-capture-fixture.mjs';

describe('isolated iOS fixture source provenance', () => {
  it('binds dirty recorder bytes and untracked fixture sources without reading keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'editor294-provenance-'));
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'apps/ios/Sources/InputCapture'), { recursive: true });
      mkdirSync(join(root, 'apps/ios/FixtureCapture/Sources'), { recursive: true });
      mkdirSync(join(root, 'keys'));
      writeFileSync(join(root, 'keys/never-read.key'), 'private fixture data');
      const recorder = join(root, 'apps/ios/Sources/InputCapture/NativeInputRecorder.swift');
      writeFileSync(recorder, 'original');
      execFileSync('git', ['-C', root, 'add', 'apps']);
      execFileSync('git', [
        '-C',
        root,
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'user.name=Test',
        'commit',
        '-qm',
        'fixture',
      ]);
      const clean = sourceProvenance(root);
      writeFileSync(recorder, 'changed');
      writeFileSync(join(root, 'apps/ios/FixtureCapture/Sources/New.swift'), 'new source');
      const dirty = sourceProvenance(root);
      expect(dirty.sourceSHA).toBe(clean.sourceSHA);
      expect(dirty.sourceFingerprint).not.toBe(clean.sourceFingerprint);
      expect(dirty.files.map((file) => file.path)).toContain(
        'apps/ios/FixtureCapture/Sources/New.swift',
      );
      expect(dirty.files.every((file) => !file.path.startsWith('keys/'))).toBe(true);
      expect(sourceProvenance(root)).toEqual(dirty);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

import { assertFixtureSimulator } from './ios-capture-fixture.mjs';

describe('fixture test destination', () => {
  it('refuses physical, sibling, stale and unbooted destinations before testing', () => {
    const root = '/task/worktree';
    const selected = '00000000-0000-0000-0000-000000000001';
    const valid = { name: 'futo-qa-0', udid: selected, state: 'Booted' };
    const owned = { worktree: root, id: selected, wipePending: false };
    const options = { inspect: (name) => (name === valid.name ? valid : null), owner: () => owned };
    expect(assertFixtureSimulator(root, selected, options)).toBe(selected);
    for (const mutation of [
      { owner: () => ({ ...owned, worktree: '/other' }) },
      { owner: () => ({ ...owned, wipePending: true }) },
      { owner: () => ({ ...owned, id: 'stale' }) },
      { inspect: () => ({ ...valid, state: 'Shutdown' }) },
    ]) {
      expect(() => assertFixtureSimulator(root, selected, { ...options, ...mutation })).toThrow();
    }
    expect(() => assertFixtureSimulator(root, '00008150-PHYSICAL', options)).toThrow();
    expect(() => assertFixtureSimulator(root, '', options)).toThrow();
  });
});

import { assertBuildIdentity } from './ios-capture-fixture.mjs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

const ffiArtifactPaths = [
  'apps/ios/Sources/Generated/futo_notes_ffi.swift',
  'apps/ios/FutoNotesFfi.xcframework/Info.plist',
  'apps/ios/FutoNotesFfi.xcframework/ios-arm64/Headers/module.modulemap',
  'apps/ios/FutoNotesFfi.xcframework/ios-arm64/Headers/futo_notes_ffiFFI.h',
  'apps/ios/FutoNotesFfi.xcframework/ios-arm64/libfuto_notes_ffi.a',
  'apps/ios/FutoNotesFfi.xcframework/ios-arm64_x86_64-simulator/libfuto_notes_ffi.a',
];

describe('fixture generated-artifact identity', () => {
  it('refuses a stale generated library even when the current Rust source is unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'editor294-artifact-'));
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(root, 'Cargo.toml'), '[workspace]');
      execFileSync('git', ['-C', root, 'add', 'Cargo.toml']);
      execFileSync('git', [
        '-C',
        root,
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'user.name=Test',
        'commit',
        '-qm',
        'fixture',
      ]);
      for (const path of ffiArtifactPaths) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), 'bound artifact');
      }
      const provenance = {
        ...sourceProvenance(root),
        artifacts: ffiArtifactPaths.map((path) => ({
          path,
          sha256: createHash('sha256').update('bound artifact').digest('hex'),
        })),
      };
      expect(() => assertBuildIdentity(root, provenance)).not.toThrow();
      writeFileSync(join(root, ffiArtifactPaths[ffiArtifactPaths.length - 1]), 'stale artifact');
      expect(() => assertBuildIdentity(root, provenance)).toThrow(/FFI artifact/);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

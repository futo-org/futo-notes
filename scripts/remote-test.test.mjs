import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { RSYNC_EXCLUDES } from './remote-test.mjs';

const scratchpads = [];
afterEach(() => {
  for (const dir of scratchpads.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('transfers native sources while excluding generated native build trees', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'remote-rsync-'));
  scratchpads.push(root);
  const source = path.join(root, 'source');
  const dest = path.join(root, 'dest');
  mkdirSync(dest);
  const sources = [
    'apps/android/app/src/main/App.kt',
    'apps/android/gradle/wrapper/gradle-wrapper.jar',
    'apps/ios/Sources/App.swift',
    'build.rs',
  ];
  const generated = [
    'apps/android/app/build/outputs/app.apk',
    'apps/android/build/cache.bin',
    'apps/android/.gradle/cache.bin',
    'apps/android/.kotlin/cache.bin',
    'apps/android/app/src/main/jniLibs/arm64-v8a/libfuto.so',
    'apps/android/app/src/main/java/uniffi/generated.kt',
    'apps/android/app/src/main/assets/editor.html',
    'apps/ios/.build-release-compliance/cache.bin',
    'apps/ios/DerivedData/cache.bin',
    'apps/ios/FutoNotes.xcframework/lib.a',
    'apps/ios/FutoNotes.xcodeproj/project.pbxproj',
    'apps/ios/Sources/Generated/bindings.swift',
    'apps/ios/Resources/editor.html',
  ];
  for (const file of [...sources, ...generated]) {
    const target = path.join(source, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'fixture');
  }
  const result = spawnSync(
    'rsync',
    [
      '-a',
      '--dry-run',
      '--out-format=%n',
      ...RSYNC_EXCLUDES.flatMap((pattern) => ['--exclude', pattern]),
      `${source}/`,
      `${dest}/`,
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  const transferred = result.stdout.trim().split('\n');
  for (const file of sources) expect(transferred).toContain(file);
  for (const file of generated) expect(transferred).not.toContain(file);
});

it.each([
  ['Host key verification failed.', 'Verify the host fingerprint with Justin'],
  ['Permission denied (publickey).', 'ask Justin to authorize your public key'],
])('explains SSH setup failure: %s', (diagnostic, hint) => {
  const root = mkdtempSync(path.join(tmpdir(), 'remote-ssh-'));
  scratchpads.push(root);
  writeFileSync(
    path.join(root, 'ssh'),
    '#!/bin/sh\nprintf "%s\\n" "$SSH_DIAGNOSTIC" >&2\nexit 255\n',
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    ['scripts/remote-test.mjs', '--host', 'fixture', '--doctor'],
    {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SSH_DIAGNOSTIC: diagnostic },
      encoding: 'utf8',
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(hint);
  expect(result.stderr).toContain('justin@fixture');
});

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

const scratchDirs = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture({ corrupt = false, platform = 'Linux/x86_64', fallback = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-nextest install-'));
  scratchDirs.push(dir);
  for (const part of ['ci', 'scripts', 'bin', 'archive', 'installed'])
    fs.mkdirSync(path.join(dir, part));
  fs.copyFileSync('ci/install-nextest.sh', path.join(dir, 'ci/install-nextest.sh'));
  const executable = path.join(dir, 'archive/cargo-nextest');
  fs.writeFileSync(executable, '#!/bin/sh\necho "cargo-nextest 0.9.149 (fixture)"\n', {
    mode: 0o755,
  });
  const archive = path.join(dir, 'nextest.tar.gz');
  expect(
    spawnSync('tar', ['-czf', archive, '-C', path.dirname(executable), 'cargo-nextest']).status,
  ).toBe(0);
  const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(
    path.join(dir, 'scripts/cargo-nextest-pin.json'),
    JSON.stringify({
      version: '0.9.149',
      archives: {
        [platform.startsWith('Darwin') ? 'Darwin' : platform]: {
          asset: 'fixture.tar.gz',
          sha256: corrupt ? '0'.repeat(64) : sha256,
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'bin/curl'),
    `#!/usr/bin/env node\nconst fs=require('node:fs');fs.appendFileSync(process.env.TEST_CURL_CALLS,'called\\n');fs.copyFileSync(process.env.TEST_ARCHIVE, process.argv[process.argv.indexOf('-o')+1]);\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(dir, 'bin/uname'),
    `#!/bin/sh\nif [ "$1" = -s ]; then echo ${platform.split('/')[0]}; else echo ${platform.split('/')[1]}; fi\n`,
    { mode: 0o755 },
  );
  if (fallback) {
    for (const tool of ['node', 'tar', 'install', 'mktemp', 'dirname', 'mkdir', 'rm', 'gzip']) {
      const resolved = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'lookup', tool], {
        encoding: 'utf8',
      });
      expect(resolved.status).toBe(0);
      fs.symlinkSync(resolved.stdout.trim(), path.join(dir, 'bin', tool));
    }
    fs.writeFileSync(
      path.join(dir, 'bin/shasum'),
      `#!/usr/bin/env node
const fs=require('node:fs'),crypto=require('node:crypto');
if(process.argv.slice(2).join(' ')!=='-a 256 -c -')process.exit(2);
const line=fs.readFileSync(0,'utf8').trimEnd(),at=line.indexOf('  ');
const got=crypto.createHash('sha256').update(fs.readFileSync(line.slice(at+2))).digest('hex');
process.exit(got===line.slice(0,at)?0:1);
`,
      { mode: 0o755 },
    );
  }
  const env = {
    ...process.env,
    PATH: fallback ? path.join(dir, 'bin') : `${dir}/bin${path.delimiter}${process.env.PATH}`,
    NEXTEST_INSTALL_DIR: path.join(dir, 'installed'),
    TEST_ARCHIVE: archive,
    TEST_CURL_CALLS: path.join(dir, 'calls'),
  };
  return {
    dir,
    run: () =>
      spawnSync('/bin/sh', [path.join(dir, 'ci/install-nextest.sh')], { env, encoding: 'utf8' }),
  };
}

it.each(['Linux/x86_64', 'Linux/aarch64', 'Darwin/arm64'])(
  'installs a verified %s archive and reuses the pinned tool without downloading again',
  (platform) => {
    const f = fixture({ platform });
    expect(f.run().status).toBe(0);
    expect(f.run().status).toBe(0);
    expect(fs.readFileSync(path.join(f.dir, 'calls'), 'utf8')).toBe('called\n');
  },
);

it('rejects a checksum mismatch without replacing an existing tool', () => {
  const f = fixture({ corrupt: true });
  const installed = path.join(f.dir, 'installed/cargo-nextest');
  const old = '#!/bin/sh\necho "cargo-nextest 0.0.0 (old)"\n';
  fs.writeFileSync(installed, old, { mode: 0o755 });
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(/FAILED|did not match/);
  expect(fs.readFileSync(installed, 'utf8')).toBe(old);
});

it('verifies the portable shasum fallback when GNU sha256sum is unavailable', () => {
  const f = fixture({ platform: 'Darwin/arm64', fallback: true });
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
});

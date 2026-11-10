import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

it.each([['new', 'lane'], ['lane']])(
  'creates %j without walking or cloning the primary Rust cache',
  (...command) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-wt-no-clone-'));
    try {
      const repo = path.join(scratch, 'notes');
      const bin = path.join(scratch, 'bin');
      const marker = path.join(scratch, 'copy-invoked');
      fs.mkdirSync(repo);
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(repo, 'target'));
      for (const args of [
        ['init', '-b', 'main'],
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '--allow-empty',
          '-m',
          'initial',
        ],
      ]) {
        const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
      }
      fs.writeFileSync(
        path.join(bin, 'cp'),
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.FUTO_TEST_COPY_MARKER, 'called');\nprocess.exit(1);\n`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./worktree.mjs', import.meta.url)),
          ...command,
          '--base',
          'main',
          '--no-install',
        ],
        {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            FUTO_TEST_COPY_MARKER: marker,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(marker), 'creating a worktree must not invoke the cache copy').toBe(
        false,
      );
      expect(fs.existsSync(path.join(scratch, 'notes-lane', 'target'))).toBe(false);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
);

// A clone stamped with copy-time mtimes looks newer than the worktree's freshly
// checked-out sources, so cargo reuses the primary checkout's stale crates and
// builds or tests old code. The clone must keep each artifact's original mtime.
it.skipIf(!['linux', 'darwin'].includes(process.platform))(
  'clone-target keeps artifact mtimes so cargo rebuilds against the worktree sources',
  () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-wt-clone-mtime-'));
    try {
      const repo = path.join(scratch, 'notes');
      const dest = path.join(scratch, 'notes-lane');
      const bin = path.join(scratch, 'bin');
      fs.mkdirSync(path.join(repo, 'target'), { recursive: true });
      fs.mkdirSync(dest);
      fs.mkdirSync(bin);
      const artifact = path.join(repo, 'target', 'artifact');
      fs.writeFileSync(artifact, 'built from older sources');
      const built = new Date('2020-01-02T03:04:05Z');
      fs.utimesSync(artifact, built, built);
      // tmpfs cannot reflink, so run the real cp with only the copy-on-write flag removed.
      fs.writeFileSync(
        path.join(bin, 'cp'),
        `#!/bin/sh\nargs=""\nfor a in "$@"; do case "$a" in --reflink=always|-c) ;; *) args="$args '$a'";; esac; done\neval exec /bin/cp $args\n`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./worktree.mjs', import.meta.url)), 'clone-target', dest],
        {
          cwd: repo,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(fs.statSync(path.join(dest, 'target', 'artifact')).mtimeMs).toBe(built.getTime());
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
);

for (const mode of ['failure', 'success', 'racing-success']) {
  it.skipIf(!['linux', 'darwin'].includes(process.platform))(
    `clone-target: ${mode} publishes only a complete clone and preserves concurrent builds`,
    () => {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-wt-clone-'));
      try {
        const repo = path.join(scratch, 'notes');
        const dest = path.join(scratch, 'notes-lane');
        const bin = path.join(scratch, 'bin');
        fs.mkdirSync(repo);
        fs.mkdirSync(bin);
        fs.mkdirSync(path.join(repo, 'target'));
        const git = (args) => {
          const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
          expect(r.status, r.stderr).toBe(0);
        };
        git(['init', '-b', 'main']);
        git([
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '--allow-empty',
          '-m',
          'initial',
        ]);
        fs.mkdirSync(dest);
        fs.writeFileSync(
          path.join(bin, 'cp'),
          `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const clone = process.argv.at(-1);
fs.mkdirSync(clone, { recursive: true });
fs.writeFileSync(path.join(clone, 'artifact'), 'cloned cache');
if (process.env.FUTO_TEST_MODE === 'success') process.exit(0);
const live = path.join(process.env.FUTO_TEST_DEST, 'target');
fs.mkdirSync(live, { recursive: true });
fs.writeFileSync(path.join(live, 'cargo-output'), 'concurrent build');
process.stderr.write('injected copy failure');
process.exit(process.env.FUTO_TEST_MODE === 'failure' ? 1 : 0);
`,
          { mode: 0o755 },
        );
        const args = ['clone-target', dest];
        const result = spawnSync(
          process.execPath,
          [fileURLToPath(new URL('./worktree.mjs', import.meta.url)), ...args],
          {
            cwd: repo,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${bin}${path.delimiter}${process.env.PATH}`,
              FUTO_TEST_DEST: dest,
              FUTO_TEST_MODE: mode,
            },
          },
        );
        expect(result.status, result.stderr).toBe(mode === 'success' ? 0 : 1);
        expect(fs.existsSync(path.join(dest, 'target', 'cargo-output')), result.stderr).toBe(
          mode !== 'success',
        );
        expect(fs.existsSync(path.join(dest, 'target', 'artifact'))).toBe(mode === 'success');
        expect(fs.readdirSync(dest).filter((name) => name.startsWith('.target-clone-'))).toEqual(
          [],
        );
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
}

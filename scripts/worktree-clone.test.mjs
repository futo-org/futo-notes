import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

for (const command of ['new', 'clone-target']) {
  for (const mode of ['failure', 'success', 'racing-success']) {
    it.skipIf(!['linux', 'darwin'].includes(process.platform))(
      `${command}: ${mode} publishes only a complete clone and preserves concurrent builds`,
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
          if (command === 'clone-target') fs.mkdirSync(dest);
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
          const args =
            command === 'new'
              ? ['new', 'lane', '--base', 'main', '--no-install']
              : ['clone-target', dest];
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
          expect(result.status, result.stderr).toBe(
            command === 'new' || mode === 'success' ? 0 : 1,
          );
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
}

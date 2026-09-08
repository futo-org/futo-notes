import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./dev-env.sh', import.meta.url));

it('runs a command from the repo root with the pinned Node and preserves literal arguments and failure status', () => {
  const result = spawnSync(
    'bash',
    [
      script,
      'node',
      '-e',
      'console.log(JSON.stringify({ arg: process.argv[1], cwd: process.cwd(), node: process.version })); process.exit(7)',
      'space; $(not-a-command)',
    ],
    { cwd: '/tmp', encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(7);
  expect(JSON.parse(result.stdout)).toEqual({
    arg: 'space; $(not-a-command)',
    cwd: fs.realpathSync(fileURLToPath(new URL('..', import.meta.url))),
    node: 'v' + fs.readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim(),
  });
});

import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('runs an async diagnostic as a module and preserves literal source and arguments', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const code =
    'const value = await Promise.resolve(42); console.log(JSON.stringify([value, "fence: ```", process.argv.slice(1)]));';
  const result = spawnSync(
    'just',
    ['node-eval', code, 'two words', '$HOME', '$(printf substituted)', '--version', '-x'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    42,
    'fence: ```',
    ['two words', '$HOME', '$(printf substituted)', '--version', '-x'],
  ]);
});

it('does not let a leading probe argument become a Node option', () => {
  const result = spawnSync(
    'just',
    ['node-eval', 'console.log(JSON.stringify(process.argv.slice(1)))', '--version', '-x'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('["--version","-x"]');
});

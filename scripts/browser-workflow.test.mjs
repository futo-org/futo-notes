// Exercise the public recipes with a capture-only pnpm: argument boundaries,
// opt-in server reuse, and failure status must survive the shell wrapper.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(recipe, args = [], status = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-recipes-'));
  dirs.push(dir);
  const capture = join(dir, 'argv.json');
  writeFileSync(
    join(dir, 'pnpm'),
    `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.BROWSER_CAPTURE, JSON.stringify({args:process.argv.slice(2),noWatch:process.env.FUTO_VITE_NO_WATCH,reuse:process.env.PLAYWRIGHT_REUSE_DEV_SERVER,skipGC:process.env.PLAYWRIGHT_SKIP_BROWSER_GC}));\nprocess.exit(Number(process.env.BROWSER_EXIT));\n`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${dir}${delimiter}${process.env.PATH}`,
    BROWSER_CAPTURE: capture,
    BROWSER_EXIT: String(status),
  };
  delete env.FUTO_VITE_NO_WATCH;
  delete env.PLAYWRIGHT_REUSE_DEV_SERVER;
  delete env.PLAYWRIGHT_SKIP_BROWSER_GC;
  const result = spawnSync('just', [recipe, ...args], { cwd: root, env, encoding: 'utf8' });
  return { result, capture: () => JSON.parse(readFileSync(capture, 'utf8')) };
}

it.skipIf(process.platform === 'win32')(
  'installs the project-pinned Chromium by default and forwards explicit browsers',
  () => {
    const first = run('browser-install');
    expect(first.result.status, first.result.stderr).toBe(0);
    expect(first.capture().args).toEqual(['exec', 'playwright', 'install', 'chromium']);
    expect(first.capture().skipGC).toBe('1');
    const explicit = run('browser-install', ['chromium', 'webkit']);
    expect(explicit.result.status, explicit.result.stderr).toBe(0);
    expect(explicit.capture().args).toEqual([
      'exec',
      'playwright',
      'install',
      'chromium',
      'webkit',
    ]);
  },
);

it.skipIf(process.platform === 'win32')(
  'disables diagnostic-server watches without silently enabling reuse',
  () => {
    const { result, capture } = run('web-diagnostic', ['--host', '127.0.0.1']);
    expect(result.status, result.stderr).toBe(0);
    expect(capture()).toEqual({ args: ['run', 'dev', '--host', '127.0.0.1'], noWatch: '1' });
  },
);

it.skipIf(process.platform === 'win32')(
  'makes server reuse explicit and preserves literal test filters and failure',
  () => {
    const args = ['--grep', 'two words $(false)', '--project=chromium'];
    const { result, capture } = run('test-e2e-reuse', args, 23);
    expect(capture()).toEqual({ args: ['exec', 'playwright', 'test', ...args], reuse: '1' });
    expect(result.status, result.stderr).toBe(23);
  },
);

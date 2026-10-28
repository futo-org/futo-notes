import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./ios-test-session.py', import.meta.url));
const dirs = [];
const children = [];

function fixtureEnv() {
  const env = { ...process.env };
  // These child repositories intentionally own independent OS locks.
  delete env.FUTO_IOS_TEST_LOCK_FD;
  return env;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ios-test-session-'));
  dirs.push(root);
  expect(spawnSync('git', ['init', '-q', root]).status).toBe(0);
  return root;
}

const run = (root, ...args) =>
  spawnSync('python3', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    env: fixtureEnv(),
  });

async function waitForFile(file, child) {
  const limit = Date.now() + 4000;
  while (!existsSync(file)) {
    if (child.exitCode !== null)
      throw new Error(`session exited ${child.exitCode} before readiness`);
    if (Date.now() > limit) throw new Error(`no readiness file ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForStatus(root, phase) {
  const deadline = Date.now() + 4000;
  for (;;) {
    const status = run(root, '--status');
    if (status.status === 0 && status.stdout.includes(phase)) return status;
    if (Date.now() > deadline) throw new Error(`session never reported ${phase}: ${status.stdout}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function hold(root, { diagnostics = false } = {}) {
  const ready = join(root, 'ready');
  const release = join(root, 'release');
  const source = `import { writeFileSync, existsSync } from 'node:fs';
    console.log(${JSON.stringify(diagnostics ? 'Collecting crash diagnostics' : 'TESTS FINISHED')});
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    const timer = setInterval(() => {
      if (existsSync(${JSON.stringify(release)})) { clearInterval(timer); }
    }, 10);`;
  const child = spawn(
    'python3',
    [script, '--', process.execPath, '--input-type=module', '-e', source],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: fixtureEnv(),
    },
  );
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const done = new Promise((resolve) => child.once('close', (code) => resolve({ code, output })));
  return { child, ready, release, done };
}

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGTERM');
  for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('iOS native test session', () => {
  it('propagates a failing test command and releases the exact worktree lock', () => {
    const root = fixture();
    const failed = run(root, '--', process.execPath, '-e', 'process.exit(65)');
    expect(failed.status, failed.stderr).toBe(65);
    const next = run(root, '--', process.execPath, '-e', 'console.log("next")');
    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout.trim()).toBe('next');
  });

  it('rejects a rerun until the real process exits, even after tests print success', async () => {
    const root = fixture();
    const first = hold(root);
    await waitForFile(first.ready, first.child);
    const marker = join(root, 'second-was-run');
    const second = run(
      root,
      '--',
      process.execPath,
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`,
    );
    expect(second.status, second.stderr).toBe(75);
    expect(second.stderr).toContain('already running');
    expect(existsSync(marker)).toBe(false);
    writeFileSync(first.release, 'finish');
    expect((await first.done).code).toBe(0);
    expect(run(root, '--status').stdout).toContain('no active');
  });

  it('shows diagnostic collection while retaining the live process lock', async () => {
    const root = fixture();
    const first = hold(root, { diagnostics: true });
    await waitForFile(first.ready, first.child);
    const status = await waitForStatus(root, 'collecting diagnostics');
    expect(status.stdout).toContain('active —');
    expect(run(root, '--clear-stale').status).toBe(75);
    writeFileSync(first.release, 'finish');
    expect((await first.done).output).toContain('lock retained');
  });

  it('isolates locks across linked worktrees', async () => {
    const root = fixture();
    expect(
      spawnSync('git', [
        '-C',
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-qm',
        'init',
      ]).status,
    ).toBe(0);
    const peer = join(root, 'peer');
    expect(spawnSync('git', ['-C', root, 'worktree', 'add', '-qb', 'peer', peer]).status).toBe(0);
    const first = hold(root);
    await waitForFile(first.ready, first.child);
    expect(run(peer, '--', process.execPath, '-e', 'process.exit(0)').status).toBe(0);
    writeFileSync(first.release, 'finish');
    expect((await first.done).code).toBe(0);
  });

  it('handles help and invalid flags before touching a worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-session-args-'));
    dirs.push(root);
    expect(run(root, '--help').status).toBe(0);
    expect(run(root, '--oops').status).toBe(2);
    expect(existsSync(join(root, '.git'))).toBe(false);
  });
});

it.skipIf(process.platform === 'win32')(
  'retains the OS lock in a running child after the runner is killed',
  async () => {
    const root = fixture();
    const first = hold(root);
    await waitForFile(first.ready, first.child);
    first.child.kill('SIGKILL');
    await first.done;
    expect(run(root, '--clear-stale').status).toBe(75);
    expect(run(root, '--', process.execPath, '-e', 'process.exit(0)').status).toBe(75);
    writeFileSync(first.release, 'finish');
    const deadline = Date.now() + 4000;
    while (!run(root, '--status').stdout.includes('no active')) {
      if (Date.now() > deadline) throw new Error('child never released its inherited lock');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(run(root, '--', process.execPath, '-e', 'process.exit(0)').status).toBe(0);
  },
);

it.skipIf(process.platform === 'win32')(
  'does not confuse stale metadata with a live OS lock',
  () => {
    const root = fixture();
    writeFileSync(join(root, '.git', 'futo-ios-test-session.json'), '{"pid":1,"phase":"stale"}');
    expect(run(root, '--status').stdout).toContain('no active');
    expect(run(root, '--', process.execPath, '-e', 'process.exit(0)').status).toBe(0);
  },
);

it.skipIf(process.platform === 'win32')(
  'interrupts its own process group without disturbing a peer session',
  async () => {
    const root = fixture();
    const peerRoot = fixture();
    const first = hold(root);
    const peer = hold(peerRoot);
    await Promise.all([waitForFile(first.ready, first.child), waitForFile(peer.ready, peer.child)]);
    first.child.kill('SIGTERM');
    expect((await first.done).code).toBe(143);
    expect(run(root, '--status').stdout).toContain('no active');
    expect(run(peerRoot, '--status').stdout).toContain('active —');
    writeFileSync(peer.release, 'finish');
    expect((await peer.done).code).toBe(0);
  },
);

it.skipIf(process.platform === 'win32')(
  'rejects an invalid diagnostic policy before starting any work',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-session-invalid-policy-'));
    dirs.push(root);
    const result = spawnSync('python3', [script, '--', process.execPath, '-e', 'process.exit(0)'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FUTO_IOS_TEST_DIAGNOSTICS: 'always' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('FUTO_IOS_TEST_DIAGNOSTICS');
    expect(existsSync(join(root, '.git'))).toBe(false);
  },
);

it.skipIf(process.platform === 'win32')(
  'lets a nested public test recipe adopt the exact inherited lock',
  () => {
    const root = fixture();
    const result = run(
      root,
      '--',
      'python3',
      script,
      '--',
      process.execPath,
      '-e',
      'console.log("nested")',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('nested');
  },
);

it.skipIf(process.platform === 'win32')(
  'refuses a bogus inherited descriptor before running a command',
  () => {
    const root = fixture();
    const result = spawnSync(
      'python3',
      [script, '--', process.execPath, '-e', 'console.log("bad")'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, FUTO_IOS_TEST_LOCK_FD: '999999' },
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid inherited iOS test lock');
    expect(result.stdout).toBe('');
  },
);

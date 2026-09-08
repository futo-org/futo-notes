import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { list, pidAlive, start, stop, tail, wait } from './detached.mjs';

describe('detached runs', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'futo-detached-'));
  });
  afterEach(() => {
    for (const r of list(root)) if (r.alive) stop(r.name, { root });
    rmSync(root, { recursive: true, force: true });
  });

  it('records the exit code and the log durably, independent of the caller', async () => {
    start('probe', ['sh', '-c', 'echo hello; echo oops >&2; exit 3'], { root });
    const run = await wait('probe', { root, pollMs: 20 });
    expect(run.exit).toBe(3);
    expect(tail(run.dir)).toContain('hello');
    expect(tail(run.dir)).toContain('oops');
    expect(list(root).map((r) => [r.name, r.exit])).toEqual([['probe', 3]]);
  });

  it('refuses to start a second run with the same name while the first is alive, and stop() kills it', async () => {
    const run = start('long', ['sleep', '30'], { root });
    expect(pidAlive(run.pid)).toBe(true);
    expect(() => start('long', ['true'], { root })).toThrow(/still running/);
    const stopped = stop('long', { root });
    expect(stopped.exit).toBe(143);
    // give the group a moment to die
    await new Promise((r) => setTimeout(r, 100));
    expect(pidAlive(run.pid)).toBe(false);
  });

  it('wait() honours a timeout and reports the run as still running', async () => {
    start('slow', ['sleep', '5'], { root });
    const run = await wait('slow', { root, timeoutMs: 50, pollMs: 10 });
    expect(run.timedOut).toBe(true);
    expect(run.exit).toBeNull();
  });

  it('rejects unsafe run names', () => {
    expect(() => start('../x', ['true'], { root })).toThrow();
  });
});

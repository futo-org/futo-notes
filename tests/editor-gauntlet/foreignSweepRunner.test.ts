import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  memorySlots,
  resumableShard,
  serviceArgs,
  withSchedulerLock,
} from './runForeignShards.mjs';

describe('corpus sweep resource and resume contract', () => {
  it('reserves headroom and caps parallelism instead of launching every shard', () => {
    expect(memorySlots({ available: 32, reserve: 8, perShard: 8, maxParallel: 16 })).toBe(3);
    expect(memorySlots({ available: 32, reserve: 8, perShard: 8, maxParallel: 2 })).toBe(2);
    expect(memorySlots({ available: 7, reserve: 8, perShard: 8, maxParallel: 16 })).toBe(0);
  });

  it('accepts only a successful matching shard and its own current report', () => {
    const plan = {
      fingerprint: 'run-a',
      head: 'head-a',
      corpusSha256: 'corpus-a',
      shards: 2,
      expectedRecords: 4,
    };
    const status = { fingerprint: 'run-a', index: 0, exitCode: 0 };
    const report = {
      corpusSha256: 'corpus-a',
      shard: { index: 0, count: 2 },
      config: {
        candidateRevision: 'head-a',
        corpusSha256: 'corpus-a',
        shardCount: 2,
        expectedRecords: 4,
        maxNotes: null,
        artifactCapture: 'off-retry-on-failure',
      },
      corpus: { reachedEof: true },
    };
    expect(resumableShard(plan, 0, status, report)).toBe(true);
    expect(resumableShard(plan, 0, { ...status, exitCode: 1 }, report)).toBe(false);
    expect(resumableShard(plan, 0, { ...status, fingerprint: 'run-b' }, report)).toBe(false);
    expect(resumableShard(plan, 1, status, report)).toBe(false);
    expect(resumableShard(plan, 0, status, null)).toBe(false);
    expect(
      resumableShard(plan, 0, status, {
        ...report,
        config: { ...report.config, candidateRevision: 'head-b' },
      }),
    ).toBe(false);
    expect(resumableShard(plan, 0, status, { ...report, corpus: { reachedEof: false } })).toBe(
      false,
    );
  });

  it('uses a distinct capped service and absolute Node path with literal arguments', () => {
    const args = serviceArgs({
      root: '/repo with spaces',
      dir: '/repo with spaces/run',
      memoryBytes: 42,
      unit: 'futo-corpus-a-0',
      script: '/repo with spaces/runner.mjs',
      node: '/node dir/node',
      index: 0,
    });
    expect(args).toContain('--property=MemoryMax=42');
    expect(args).toContain('--property=MemorySwapMax=0');
    expect(args).toContain('--property=WorkingDirectory=/repo with spaces');
    expect(args.slice(-5)).toEqual([
      '/node dir/node',
      '/repo with spaces/runner.mjs',
      '--shard',
      '/repo with spaces/run',
      '0',
    ]);
    expect(args).not.toContain('--scope');
  });
});

const cliPaths = process.platform === 'win32' ? [false] : [false, true];
it.each(cliPaths)('validates CLI input before side effects (alias=%s)', (alias) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-corpus-cli-'));
  try {
    let entry = fileURLToPath(new URL('./runForeignShards.mjs', import.meta.url));
    if (alias) {
      const link = path.join(scratch, 'runner.mjs');
      fs.symlinkSync(entry, link);
      entry = link;
    }
    const help = spawnSync(process.execPath, [entry, '--help'], {
      cwd: scratch,
      encoding: 'utf8',
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('gauntlet-milkdown-sweep');
    const invalid = spawnSync(process.execPath, [entry, '--unknown'], {
      cwd: scratch,
      encoding: 'utf8',
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('unknown argument --unknown');
    expect(fs.readdirSync(scratch)).toEqual(alias ? ['runner.mjs'] : []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== 'linux')(
  'rejects a concurrent scheduler through an OS lock and releases it after exit',
  async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-corpus-lock-'));
    const ready = path.join(scratch, 'ready');
    const release = path.join(scratch, 'release');
    const lock = path.join(scratch, 'scheduler.lock');
    const first = withSchedulerLock(lock, [
      process.execPath,
      '-e',
      "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'');setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0)},10)",
      ready,
      release,
    ]);
    try {
      const until = Date.now() + 3000;
      while (!fs.existsSync(ready)) {
        if (Date.now() > until) throw new Error('first scheduler did not acquire its lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await withSchedulerLock(lock, [process.execPath, '-e', 'process.exit(0)'])).toBe(73);
    } finally {
      fs.writeFileSync(release, '');
      await first;
    }
    try {
      expect(await withSchedulerLock(lock, [process.execPath, '-e', 'process.exit(0)'])).toBe(0);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
);

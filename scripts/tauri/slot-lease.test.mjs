import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimTauriSlot } from './slot-lease.mjs';
import { slotOf } from '../lib/slot.mjs';
import { readFileSync } from 'node:fs';

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-slot-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('Tauri slot lease', () => {
  it('routes desktop QA launches through the lease-owning launcher', () => {
    const instructions = readFileSync(
      new URL('../../.claude/skills/verify/references/desktop.md', import.meta.url),
      'utf8',
    );
    const launch = instructions.slice(
      instructions.indexOf('(cd "$WORKTREE_ROOT" && just tauri-dev)'),
      instructions.indexOf('### Discover the MCP bridge port'),
    );
    expect(launch).toContain('(cd "$WORKTREE_ROOT" && just tauri-dev)');
    expect(launch).not.toContain('cargo tauri dev');
    const launcher = readFileSync(new URL('../tauri-dev.mjs', import.meta.url), 'utf8');
    expect(launcher).toContain('const identifier = devBundleId(repoRoot);');
  });

  it('refuses a live colliding worktree while preserving the established slot hash', () => {
    const dir = tempDir();
    const first = '/worktrees/one';
    let second;
    for (let i = 0; i < 1000; i += 1) {
      const candidate = `/worktrees/collision-${i}`;
      if (candidate !== first && slotOf(candidate) === slotOf(first)) {
        second = candidate;
        break;
      }
    }
    expect(second).toBeDefined();
    const release = claimTauriSlot(first, dir);
    expect(() => claimTauriSlot(second, dir)).toThrow(/in use by \/worktrees\/one/);
    release();
    expect(() => claimTauriSlot(second, dir)).not.toThrow();
  });

  it('does not automatically delete a stale lease that could race a new owner', () => {
    const dir = tempDir();
    const root = '/worktrees/stale';
    const file = path.join(dir, `s${slotOf(root)}.json`);
    fs.writeFileSync(file, JSON.stringify({ worktree: root, pid: 99999999 }));
    let next;
    for (let i = 0; i < 1000; i += 1) {
      const candidate = `/worktrees/next-${i}`;
      if (candidate !== root && slotOf(candidate) === slotOf(root)) {
        next = candidate;
        break;
      }
    }
    expect(next).toBeDefined();
    expect(() => claimTauriSlot(next, dir)).toThrow(/verify that process is gone/);
    expect(fs.existsSync(file)).toBe(true);
  });
});

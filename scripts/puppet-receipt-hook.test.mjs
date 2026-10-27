import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { filteredAction } from './puppet-receipt-hook.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// The hook exactly as Claude Code runs it, shell check and all.
const wired = JSON.parse(
  readFileSync(new URL('../.claude/settings.json', import.meta.url), 'utf8'),
).hooks.PreToolUse.find((entry) => entry.matcher === 'Bash').hooks[0].command;

describe('the receipt hook', () => {
  it('refuses an action whose receipt is piped or sent away, on any target', () => {
    for (const line of [
      `just puppet do GoBack | grep status`,
      `just puppet do OpenNote '{"noteId":"a"}' | head -30`,
      `just puppet do CloseTab >/dev/null`,
      `just puppet tap '{"x":1,"y":2}' > out.txt`,
      `FUTO_PUPPET_TARGET=ios just puppet type '{"text":"x"}' 2>&1 | tail -5`,
      `just puppet state; just puppet do '[["A"],["B"]]' &>/dev/null; just puppet elements`,
      `target/debug/futo-puppet press '{"key":"Enter"}' | cat`,
      `FUTO_PUPPET_TARGET=android just puppet relaunch | tail -20`,
      `just puppet look | head -40`,
      `(just puppet do GoBack) | tail -3`,
      `cargo run -q -p futo-puppet -- do GoBack | head`,
    ]) {
      expect(filteredAction(line), line).not.toBeNull();
    }
  });

  it('lets a whole receipt, a searched read and quoted pipes through', () => {
    for (const line of [
      `just puppet do GoBack`,
      `just puppet do Insert '{"text":"a | b; c > d"}'`,
      `just puppet do OpenNote '{"noteId":"a"}' 2>&1`,
      `just puppet do OpenNote '{"noteId":"a"}' 2>/dev/null`,
      `just puppet notes | grep budget`,
      `just puppet doc | sed -n 6,10p`,
      `just puppet elements | grep -i retro; just puppet do OpenNote '{"noteId":"r"}'`,
      `just puppet do A && just puppet do B`,
      `git log | head`,
    ]) {
      expect(filteredAction(line), line).toBeNull();
    }
  });

  it('blocks through Claude Code: exit 2 with the reason on stderr', () => {
    const run = (command) => {
      try {
        execFileSync('sh', ['-c', wired], {
          input: JSON.stringify({ tool_input: { command } }),
          env: { ...process.env, CLAUDE_PROJECT_DIR: root },
          stdio: 'pipe',
        });
        return { status: 0, stderr: '' };
      } catch (error) {
        return { status: error.status, stderr: String(error.stderr) };
      }
    };
    const blocked = run('just puppet do GoBack | grep status');
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('read the receipt whole');
    const look = run('just puppet look | head -40');
    expect(look.status).toBe(2);
    expect(look.stderr).toContain('filters `look`');
    expect(run('just puppet do GoBack').status).toBe(0);
    expect(run('git log | head').status).toBe(0);
  });
});

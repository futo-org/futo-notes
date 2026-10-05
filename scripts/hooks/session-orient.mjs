#!/usr/bin/env node
// Claude Code SessionStart hook: inject `just orient` so every session opens
// knowing which worktree and slot it is in, what it owns, and what is dirty —
// instead of rediscovering the slot model from the verify skill each time.
// The hook input's `cwd` is the worktree even when CLAUDE_PROJECT_DIR is the
// primary checkout (EnterWorktree sessions), so orientation is computed there.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIENT = path.join(HERE, '..', 'agent-orient.mjs');

export function orientationFor(cwd, { spawn = spawnSync } = {}) {
  const result = spawn(process.execPath, [ORIENT], {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (result.status !== 0) {
    return `just orient failed (exit ${result.status}): ${(result.stderr || '').trim().slice(0, 400)}`;
  }
  return result.stdout.trim();
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let cwd = process.cwd();
  try {
    cwd = JSON.parse(raw).cwd || cwd;
  } catch {
    // no JSON: run against the current directory
  }
  const text = orientationFor(cwd);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    }) + '\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`session-orient hook error (ignored): ${error.message}\n`);
  });
}

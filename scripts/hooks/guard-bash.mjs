#!/usr/bin/env node
// Claude Code PreToolUse hook for the Bash tool: the RUNTIME guard behind
// AGENTS.md M24/M25 and two worktree papercuts. Until now every one of these
// rules was prose plus a gate that scans instruction files
// (scripts/check-qa-input-safety.mjs); a session improvising the technique from
// memory was only discouraged. This hook denies the call and names the
// sanctioned alternative, so the agent's next step is the right one.
//
// Wired from .claude/settings.json (project scope, so it applies in every
// worktree and to every subagent). Input arrives as JSON on stdin; a denial is
// JSON on stdout with exit 0 — exit 2 would also block, but the JSON form
// carries the reason into the agent's context.
//
// Rules, each traced to an incident:
//   - the seven check-qa-input-safety RULES (imported, so there is ONE list):
//     OS-level input, app-name lookups, process-name kills, relative -newermt
//   - `git stash` in a linked worktree: refs/stash is shared by every worktree,
//     so one lane's `stash pop` restored another lane's WIP and dropped its own
//     (two papercuts, 2026-09-01)
//   - foregrounding an app or simulator: `open -a …` / `osascript … activate`
//     drags whoever is typing to another space during parallel QA ("stop
//     opening the app!!", Mac transcripts 2026-08-14); `SHOW=1 just sim-boot`
//     is the sanctioned way when a human needs to watch
//
// The hook fails OPEN on its own errors (malformed input, a missing import):
// a broken guard must not take every Bash call down with it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RULES } from '../check-qa-input-safety.mjs';

// `stash` as git's SUBCOMMAND (after `git` and any leading options such as
// `-C <dir>`), not the word inside a path like docs/stash-notes.md. `git stash
// list` only reads; everything else moves the shared stash.
const GIT_STASH = /\bgit\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*stash(?!\s+list\b)(?=\s|$)/;
// `(?<![\w-])` keeps `xdg-open`, `reopen`, and `--open` out of it.
const FOREGROUND = [/(?<![\w-])open\s+-[ab]\s/, /\bosascript\b[^\n]*\bactivate\b/];

export const STASH_RULE = {
  id: 'git-stash-in-worktree',
  why: 'refs/stash is shared by every worktree of this repo, so a stash push here can be popped by a parallel lane and a pop here can restore THEIR work-in-progress over yours (it happened twice on 2026-09-01).',
  instead:
    'commit a WIP commit on your branch (amend or squash later), or `git diff > /tmp/…patch` and `git apply` it back. Stash only in the primary checkout, where no other lane pops.',
};

export const FOREGROUND_RULE = {
  id: 'foreground-app',
  why: 'activating an app or Simulator window drags the human to another space and steals keyboard focus — during parallel QA that has interrupted the user mid-sentence more than once. Rendering does not need a visible window; frame probes do, and those are the exception the recipe flag exists for.',
  instead:
    '`SHOW=1 just sim-boot` when a human explicitly needs to watch, `just qa-shot` to capture a window without activating it, and the webview bridge for interaction.',
};

/** Walk up from cwd to the nearest `.git`; a FILE there means a linked worktree. */
export function isLinkedWorktree(cwd, fsImpl = fs) {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    try {
      const stat = fsImpl.statSync(dotGit);
      return stat.isFile();
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Decide whether a Bash command must be denied.
 * @returns {{ id: string, why: string, instead: string, line: string } | null}
 */
export function evaluateCommand(command, { linkedWorktree = false } = {}) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  const lines = command.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    for (const rule of RULES) {
      if (rule.match(line, next)) {
        return { id: rule.id, why: rule.why, instead: rule.instead, line };
      }
    }
    if (linkedWorktree && GIT_STASH.test(line)) {
      return { ...STASH_RULE, line };
    }
    if (FOREGROUND.some((re) => re.test(line))) {
      return { ...FOREGROUND_RULE, line };
    }
  }
  return null;
}

export function denialMessage(verdict) {
  return [
    `Blocked by scripts/hooks/guard-bash.mjs (rule: ${verdict.id}).`,
    `Offending line: ${verdict.line.trim()}`,
    `Why: ${verdict.why}`,
    `Instead: ${verdict.instead}`,
  ].join('\n');
}

export function decide(input) {
  if (!input || input.tool_name !== 'Bash') return null;
  const command = input.tool_input?.command;
  const cwd = input.cwd || process.cwd();
  const verdict = evaluateCommand(command, { linkedWorktree: isLinkedWorktree(cwd) });
  if (!verdict) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denialMessage(verdict),
    },
  };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // fail open: not our shape, not our call
  }
  const decision = decide(input);
  if (decision) process.stdout.write(JSON.stringify(decision) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`guard-bash hook error (allowing the call): ${error.message}\n`);
  });
}

export const __test = { GIT_STASH, FOREGROUND, fileURLToPath };

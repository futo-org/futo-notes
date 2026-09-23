#!/usr/bin/env node
// Claude Code SubagentStart hook: give every subagent its OWN scratch directory.
//
// All lanes of a session share one scratchpad directory. Two parallel lanes
// both wrote $SCRATCHPAD/MilkdownEditor.svelte.bak and one lane's
// restore-from-backup pulled the OTHER lane's file (pc 2026-08-31); a peer
// overwrote scratchpad/shot.mjs mid-task and a lane executed the wrong script
// against its worktree (pc_e89422f7e382). The harness cannot namespace the
// shared dir, but a hook can create a private one and tell the agent about it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SAFE = /[^A-Za-z0-9._-]/g;

/** Deterministic, per-(session, agent) directory under the OS temp root. */
export function scratchDirFor({ sessionId, agentId, tmpdir = os.tmpdir(), uid = uidOf() }) {
  const clean = (s, fallback) =>
    String(s || fallback)
      .replace(/\.\.+/g, '_')
      .replace(SAFE, '_');
  const session = clean(sessionId, 'session');
  const agent = clean(agentId, 'agent');
  return path.join(tmpdir, `claude-${uid}`, 'futo-agent-scratch', session, agent);
}

function uidOf() {
  try {
    return os.userInfo().uid;
  } catch {
    return 'user';
  }
}

export function contextFor(dir) {
  return [
    `Your private scratch directory is ${dir} (created for you; empty).`,
    'Use it for any temporary file another lane could also write — backups, probe scripts, captures.',
    'The shared session scratchpad is fine for files only you will ever name.',
  ].join(' ');
}

export function decide(input, { mkdir = (p) => fs.mkdirSync(p, { recursive: true }) } = {}) {
  const dir = scratchDirFor({ sessionId: input?.session_id, agentId: input?.agent_id });
  mkdir(dir);
  return {
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext: contextFor(dir),
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
    return;
  }
  process.stdout.write(JSON.stringify(decide(input)) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`subagent-scratch hook error (ignored): ${error.message}\n`);
  });
}

#!/usr/bin/env node
// Print the Apple Developer team id for a signed iOS device build. Exits 1
// with a message on stderr when none is configured.
//
// Consumed by apps/ios/run-device.sh and apps/ios/deploy.sh. Lookup order:
//
//   1. $FUTO_DEV_TEAM
//   2. apps/ios/.signing-team in this checkout
//   3. apps/ios/.signing-team in the PRIMARY checkout
//
// Step 3 exists because .signing-team is gitignored: a fresh `git worktree`
// never has it, so a device build from any worktree used to stop with
// "Could not determine a signing team" even though the operator had set it
// once in the main checkout.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEAM_FILE = path.join('apps', 'ios', '.signing-team');

/** The primary checkout's root, or null outside git. */
function primaryCheckout(root) {
  try {
    const common = execFileSync(
      'git',
      ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return path.dirname(common);
  } catch {
    return null;
  }
}

function readTeam(file) {
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8').replace(/\s/g, '');
}

/** { team, source } — team is '' when nothing is configured. */
export function resolveSigningTeam({ root, env = process.env, primary = primaryCheckout(root) }) {
  if (env.FUTO_DEV_TEAM) return { team: env.FUTO_DEV_TEAM, source: 'FUTO_DEV_TEAM' };
  const candidates = [root, primary].filter(Boolean).map((dir) => path.join(dir, TEAM_FILE));
  for (const file of new Set(candidates)) {
    const team = readTeam(file);
    if (team) return { team, source: file };
  }
  return { team: '', source: null };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { team, source } = resolveSigningTeam({ root });
  if (!team) {
    console.error(
      'Could not determine a signing team. Set FUTO_DEV_TEAM=<10-char team id> or write ' +
        'apps/ios/.signing-team (in this checkout or the primary one).',
    );
    process.exit(1);
  }
  // The team is the only thing on stdout (callers capture it directly).
  console.error(`(signing team from ${source})`);
  process.stdout.write(team);
}

// Run only when invoked directly so the test can import the resolver.
if (import.meta.main) {
  main();
}

#!/usr/bin/env node
// Prettier over the files git knows about — NOT a bare '**/*' glob.
//
//   node scripts/format.mjs           (just format-check / pnpm format:check)
//   node scripts/format.mjs --write   (just format / pnpm format)
//
// Why this exists: `prettier --check "**/*.{ts,svelte,...}"` descends into any
// directory under the repo root, including a nested git worktree or sibling
// checkout (`wtbase/`, `.worktrees/<name>/`, `.claude/worktrees/<name>/`). Those
// are whole second copies of this repo, so a clean tree reported hundreds of
// style failures that belong to another checkout — `just check` was red for
// everyone doing parallel work, twice reported as a papercut. Adding each path
// to .prettierignore does not fix it: the reporter's point was that a sibling
// checkout can be named anything.
//
// git already draws the boundary — it does not recurse into a nested
// repository. `--cached --others --exclude-standard` still covers new,
// not-yet-committed files (so a fresh unformatted file is caught) while
// honouring .gitignore. .prettierignore is applied by prettier itself, which
// respects it for explicitly-passed paths too.
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = ['.ts', '.svelte', '.js', '.mjs', '.cjs', '.css'];

const write = process.argv.includes('--write');

const tracked = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)
  .split('\0')
  .filter(Boolean)
  .filter((f) => EXTENSIONS.some((ext) => f.endsWith(ext)));

if (tracked.length === 0) {
  console.error('No files to format — is this a git checkout?');
  process.exit(1);
}

// Chunked so a large repo cannot blow the platform's argv limit.
const CHUNK = 2000;
let failed = false;
for (let i = 0; i < tracked.length; i += CHUNK) {
  const batch = tracked.slice(i, i + CHUNK);
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules/prettier/bin/prettier.cjs'),
      write ? '--write' : '--check',
      ...batch,
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (result.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Pre-commit gate: no staged agent-authored file may exceed 5,000 tokens,
// counted as bytes / 4. Large files are hard for agents to read, edit, and
// review in one pass, so the limit pushes work toward small, focused modules.
//
//   node scripts/check-file-tokens.mjs         staged files (the pre-commit hook)
//   node scripts/check-file-tokens.mjs --all   every tracked file (audit only)
//
// It reads the STAGED blob (`git show :path`), not the working tree, so what is
// measured is exactly what would be committed.
//
// The only automatic exemption is binary content. Everything else that may be
// large — lockfiles, tool-written logs, exported art, the language catalogs —
// is named path by path in scripts/file-tokens-allowlist.json with a reason.
// There is no "debt" list: an oversized file that is not large by design gets
// split before it can be committed. The allowlist is read from the index too,
// and an entry whose file is gone or back under the limit fails as stale, so
// the list cannot quietly outlive its reasons. Deliberately absent: glob
// entries, a GENERATED-header sniff, and in-file pragmas — each lets a file
// grant itself the exception without an allowlist diff for review.

import { execFileSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';

export const MAX_TOKENS = 5000;
export const BYTES_PER_TOKEN = 4;
export const MAX_BYTES = MAX_TOKENS * BYTES_PER_TOKEN;
export const ALLOWLIST = 'scripts/file-tokens-allowlist.json';

export function tokensFor(bytes) {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

// git's own binary heuristic (a NUL byte in the first 8000 bytes), plus
// anything that is not valid UTF-8 — RLE images like .hdr have no early NUL.
export function isBinary(content) {
  return content.subarray(0, 8000).includes(0) || !isUtf8(content);
}

function measure(file, content) {
  return { file, bytes: content.length, tokens: tokensFor(content.length) };
}

export function findOversized(entries, allowed) {
  return entries
    .filter(
      ({ file, content }) => content.length > MAX_BYTES && !allowed.has(file) && !isBinary(content),
    )
    .map(({ file, content }) => measure(file, content))
    .sort((a, b) => b.tokens - a.tokens);
}

// An entry is stale when its file is no longer in the index or no longer over
// the limit. `readStaged` returns null for a path that is not staged.
export function findStale(allowed, readStaged) {
  return [...allowed].filter((file) => {
    const content = readStaged(file);
    return content === null || content.length <= MAX_BYTES;
  });
}

export function formatStale(stale) {
  return [
    `${stale.length} entr${stale.length === 1 ? 'y' : 'ies'} in ${ALLOWLIST} no longer apply (file removed or now under the limit):`,
    '',
    ...stale.map((file) => `  ${file}`),
    '',
    `Remove them from ${ALLOWLIST} and commit again.`,
  ].join('\n');
}

export function formatFailure(oversized) {
  const rows = oversized.map(
    ({ file, tokens, bytes }) =>
      `  ${file}  ~${tokens.toLocaleString('en-US')} tokens (${bytes.toLocaleString('en-US')} bytes)`,
  );
  return [
    `${oversized.length} staged file(s) exceed the ${MAX_TOKENS.toLocaleString('en-US')}-token limit (tokens = bytes / ${BYTES_PER_TOKEN}, so ${MAX_BYTES.toLocaleString('en-US')} bytes):`,
    '',
    ...rows,
    '',
    'Split each file before committing. Do not trim comments or minify to squeeze under the limit.',
    '',
    'How to split:',
    "  1. Find the seams. List the file's top-level units (functions, classes, components,",
    '     test describe-blocks, doc sections) and group them by the one job each group does.',
    '     Each group becomes a new file, named for that job — not "utils", "helpers", or "part2".',
    '  2. Put each new file next to the original, in the same directory (or a new folder named',
    '     after the original, e.g. foo.ts -> foo/parse.ts + foo/render.ts + foo/index.ts).',
    '  3. Keep the original path as the entry point when other code imports it: it re-exports or',
    '     orchestrates the pieces, so callers do not change. Otherwise update every import.',
    '  4. Move code verbatim. A split is a move, not a rewrite — no behavior changes in the same',
    '     commit, so the diff stays reviewable.',
    '  5. By file type:',
    '     - Source (.ts/.rs/.swift/.kt/.mjs): one module per responsibility. Rust: turn foo.rs into',
    '       foo/mod.rs plus submodules. Svelte: extract child components and move logic into a',
    '       sibling .svelte.ts.',
    '     - Tests: split by the behavior under test (one describe/feature per file); move shared',
    '       fixtures and helpers into a co-located helpers file both halves import.',
    '     - Markdown docs/specs: one file per top-level section, with the original kept as a short',
    '       index linking to each part. Fix every link that pointed at a moved heading.',
    '     - JSON data/fixtures: split by top-level key into several files and load them together.',
    '  6. Each new file must itself be under the limit. Re-stage everything and commit again.',
    '',
    'If the file is generated or tool-written, regenerate it instead of editing it. Adding it to',
    `${ALLOWLIST} is a decision for review, not a fix: it is only for a file that`,
    'must be one large file by design, and the entry needs a reason saying why it cannot be split.',
  ].join('\n');
}

function git(args) {
  return execFileSync('git', args, { maxBuffer: 1024 * 1024 * 1024 });
}

function readStaged(file) {
  try {
    return execFileSync('git', ['show', `:${file}`], {
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function listNames(args) {
  return git(args).toString('utf8').split('\0').filter(Boolean);
}

function loadAllowlist() {
  const raw = readStaged(ALLOWLIST);
  if (raw === null) return new Set();
  const { entries } = JSON.parse(raw.toString('utf8'));
  for (const entry of entries) {
    if (!entry.path || !entry.reason?.trim()) {
      throw new Error(
        `${ALLOWLIST}: every entry needs a "path" and a "reason" (${JSON.stringify(entry)})`,
      );
    }
  }
  return new Set(entries.map((entry) => entry.path));
}

function main() {
  const all = process.argv.includes('--all');
  const names = all
    ? listNames(['ls-files', '-z'])
    : listNames(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
  const allowed = loadAllowlist();
  const oversized = findOversized(
    names.map((file) => ({ file, content: readStaged(file) })),
    allowed,
  );
  const stale = findStale(allowed, readStaged);
  const messages = [];
  if (oversized.length > 0) {
    const message = formatFailure(oversized);
    messages.push(all ? message.replace('staged file(s)', 'tracked file(s)') : message);
  }
  if (stale.length > 0) messages.push(formatStale(stale));
  if (messages.length === 0) return;
  console.error(messages.join('\n\n'));
  process.exitCode = 1;
}

if (import.meta.main) main();

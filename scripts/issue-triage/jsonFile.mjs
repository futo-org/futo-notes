/**
 * Crash-safe JSON persistence for the triage state files.
 *
 * Both `state.json` (which issues have been seen) and `health.json` (whether
 * the poller is currently failing) must survive a crash mid-write: a truncated
 * state.json would re-post the entire backlog. Every write is therefore
 * tmp-file-then-rename, and that lives here once rather than being copied into
 * each state module.
 *
 * A malformed file is NOT treated as missing: only ENOENT falls back to the
 * default, so a corrupt state.json fails the run loudly instead of quietly
 * resetting the watermark (M11).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Read and parse a JSON file, returning `fallback` only when it does not exist.
 * @template T
 * @param {string} path
 * @param {T} fallback
 * @returns {T}
 */
export function readJsonOr(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/**
 * Write a JSON file atomically: sibling temp file, then rename over the target.
 * @param {string} path
 * @param {unknown} value
 */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

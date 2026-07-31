/**
 * Persistent triage state — the single source of truth for which issues have
 * been seen, what the poller decided, and where each one is in the pipeline.
 *
 * State is machine-local operational data (not source): a JSON file under
 * ~/.local/state/futo-notes-issue-triage/. It is read before every action and
 * written immediately after, so a crash or a machine reboot can only ever
 * delay work, never double-post or lose an issue
 * (docs/plan/github-issue-triage.md, "Idempotency").
 *
 * Shape:
 *   {
 *     watermark: "<ISO8601>",            // max issue updated_at seen so far
 *     issues: {
 *       "<number>": {
 *         status: TriageStatus,
 *         title, url, author, createdAt, updatedAt,
 *         classifiedAs: 'bug' | 'feature' | 'other',
 *         zulipTopic: string,
 *         zulipMessageId: number | null,
 *         mrUrl: string | null
 *       }
 *     }
 *   }
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Pipeline statuses. A bug advances posted → queued → reproducing → one of the
 * terminal states; a feature/other stops at posted.
 * @typedef {'posted' | 'queued' | 'reproducing' | 'mr_filed' | 'not_reproduced' | 'needs_human'} TriageStatus
 */

// First-run watermark. NOT the Unix epoch: GitHub's issues `since` filter
// treats 1970-01-01T00:00:00Z as "unset" and returns nothing, so we floor at a
// date safely before this repo (or any GitHub repo) could have issues.
const DEFAULT_WATERMARK = '2000-01-01T00:00:00Z';
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;

/** Resolve the state directory, honoring an override for tests and dry runs. */
export function stateDir() {
  return (
    process.env.FUTO_ISSUE_TRIAGE_STATE_DIR ||
    join(homedir(), '.local', 'state', 'futo-notes-issue-triage')
  );
}

function stateFilePath(dir) {
  return join(dir, 'state.json');
}

function stateLockPath(dir) {
  return join(dir, 'state.lock');
}

/**
 * Load state from disk, returning the default empty state when the file does
 * not exist yet (first run: watermark at the epoch so the whole backlog is
 * fetched).
 * @param {string} [dir]
 * @returns {{ watermark: string, issues: Record<string, object> }}
 */
export function loadState(dir = stateDir()) {
  try {
    const raw = readFileSync(stateFilePath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      watermark: parsed.watermark ?? DEFAULT_WATERMARK,
      issues: parsed.issues ?? {},
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { watermark: DEFAULT_WATERMARK, issues: {} };
    }
    throw error;
  }
}

/**
 * Persist state atomically: write a sibling temp file, then rename over the
 * target so a crash mid-write can never leave a truncated state.json.
 * @param {{ watermark: string, issues: Record<string, object> }} state
 * @param {string} [dir]
 */
export function saveState(state, dir = stateDir()) {
  const target = stateFilePath(dir);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, target);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeStaleLock(lockPath) {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs <= STALE_LOCK_MS) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

async function acquireStateLock(dir) {
  mkdirSync(dir, { recursive: true });
  const lockPath = stateLockPath(dir);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${process.pid}\n`);
      } catch (error) {
        await handle.close();
        await unlink(lockPath).catch(() => {});
        throw error;
      }
      return async () => {
        await handle.close();
        try {
          await unlink(lockPath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await removeStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for triage state lock: ${lockPath}`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

/**
 * Run one read-modify-write transaction while holding the state file's
 * cross-process lock. Callers must keep the mutation short and perform remote
 * I/O before or after the transaction.
 *
 * @template T
 * @param {(state: { watermark: string, issues: Record<string, object> }) => T | Promise<T>} mutate
 * @param {string} [dir]
 * @returns {Promise<T>}
 */
export async function updateState(mutate, dir = stateDir()) {
  const release = await acquireStateLock(dir);
  try {
    const state = loadState(dir);
    const result = await mutate(state);
    saveState(state, dir);
    return result;
  } finally {
    await release();
  }
}

/**
 * The highest issue updatedAt across current state and a fresh batch. Used to
 * advance the fetch watermark. Pure so it is trivially testable.
 * @param {string} current
 * @param {Array<{ updatedAt: string }>} issues
 * @returns {string}
 */
export function nextWatermark(current, issues) {
  return issues.reduce((max, issue) => (issue.updatedAt > max ? issue.updatedAt : max), current);
}

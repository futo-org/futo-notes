/**
 * The MR factory's I/O: its machine-local state files, GitLab, and the Zulip
 * bot. Every call throws on a non-success response so a failure reaches the
 * operator as a DM instead of a quiet skip (AGENTS.md M11).
 *
 * Credentials come from the environment (~/.config/futo-notes-mr-factory/env
 * under systemd): GITLAB_TOKEN, ZULIP_FACTORY_BOT_EMAIL, ZULIP_FACTORY_BOT_KEY.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';

const GITLAB_PROJECT_API = 'https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes';
const ZULIP_SITE = 'https://zulip.futo.org';

export function stateDir(env = process.env) {
  return (
    env.FUTO_MR_FACTORY_STATE_DIR ?? join(os.homedir(), '.local', 'state', 'futo-notes-mr-factory')
  );
}

/** Parse a JSON file; only a missing file falls back, so corruption fails loudly. */
export function readJsonOr(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/** Tmp-then-rename, so a crash mid-write cannot truncate the state. */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
}

/** Verdicts per MR, keyed by iid: `{ sha, verdict, at, noteId?, dmSent? }`. */
export function loadState(dir = stateDir()) {
  return readJsonOr(join(dir, 'state.json'), { mrs: {} });
}

export function saveState(state, dir = stateDir()) {
  writeJsonAtomic(join(dir, 'state.json'), state);
}

/** The factory's own health: `{ failing, firstFailureAt, lastAlertAt, alertCount, lastError }`. */
export function loadHealth(dir = stateDir()) {
  return readJsonOr(join(dir, 'health.json'), { failing: false, alertCount: 0 });
}

export function saveHealth(health, dir = stateDir()) {
  writeJsonAtomic(join(dir, 'health.json'), health);
}

async function gitlab(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const token = process.env.GITLAB_TOKEN;
  if (!token) throw new Error('missing GITLAB_TOKEN');
  const response = await fetchImpl(`${GITLAB_PROJECT_API}${path}`, {
    method,
    headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitLab ${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

/** Every open MR, oldest first. 100 is far above the project's open count. */
export function listOpenMrs() {
  return gitlab('/merge_requests?state=opened&order_by=created_at&sort=asc&per_page=100');
}

export function getMr(iid) {
  return gitlab(`/merge_requests/${iid}`);
}

export function postNote(iid, body) {
  return gitlab(`/merge_requests/${iid}/notes`, { method: 'POST', body: { body } });
}

export function updateLabels(iid, { add = [], remove = [] }) {
  return gitlab(`/merge_requests/${iid}`, {
    method: 'PUT',
    body: { add_labels: add.join(','), remove_labels: remove.join(',') },
  });
}

/** Send a Zulip direct message from the factory bot. */
export async function sendDm(userId, content, fetchImpl = fetch) {
  const email = process.env.ZULIP_FACTORY_BOT_EMAIL;
  const key = process.env.ZULIP_FACTORY_BOT_KEY;
  if (!email || !key) throw new Error('missing ZULIP_FACTORY_BOT_EMAIL / ZULIP_FACTORY_BOT_KEY');
  const response = await fetchImpl(`${ZULIP_SITE}/api/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${key}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ type: 'direct', to: JSON.stringify([userId]), content }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.result !== 'success') {
    throw new Error(`Zulip DM failed (${response.status}): ${result.msg ?? 'unknown error'}`);
  }
  return { id: result.id };
}

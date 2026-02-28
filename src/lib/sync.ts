import { sanitizeFilename } from './utils';
import { refreshNotesAfterSync } from './notes';
import { getCachedPreferences, savePreferences } from './preferences';
import { findIdForUuid, loadSyncState, saveSyncState } from './syncState';
import { getClientId } from './sseClient';
import { applySyncDeltaRust, prepareSyncPayloadRust } from './rustCore';
import { FALLBACK_TITLE, type HealthResponse, type LoginResponse, type SyncRequest, type SyncResponse } from '@futo-notes/shared';

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  updatedIds: string[];
  deletedIds: string[];
}

function normalizeBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url;
}

function noteIdFromFilename(filename: string): string {
  const withoutExt = filename.replace(/\.md$/i, '');
  return sanitizeFilename(withoutExt) || FALLBACK_TITLE;
}

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}: invalid JSON response`);
  }

  if (!res.ok) {
    const error =
      data &&
      typeof data === 'object' &&
      'error' in data &&
      typeof (data as Record<string, unknown>).error === 'string'
        ? (data as Record<string, string>).error
        : `HTTP ${res.status}`;
    throw new Error(error);
  }

  return data as T;
}

async function authPost<T>(baseUrl: string, token: string, path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return parseJsonOrThrow<T>(res);
}

async function setSyncError(errorMessage: string): Promise<void> {
  const prefs = getCachedPreferences();
  prefs.sync.lastError = errorMessage;
  await savePreferences(prefs);
}

async function clearSyncErrorAndSetTime(): Promise<void> {
  const prefs = getCachedPreferences();
  prefs.sync.lastError = '';
  prefs.sync.lastSyncedAt = Date.now();
  await savePreferences(prefs);
}

export async function connectSyncServer(urlInput: string, password: string): Promise<void> {
  const serverUrl = normalizeBaseUrl(urlInput);
  if (!serverUrl) throw new Error('Server URL is required');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');

  const healthRes = await fetch(`${serverUrl}/health`);
  const health = await parseJsonOrThrow<HealthResponse>(healthRes);

  if (!health.setup_complete) {
    const setupRes = await fetch(`${serverUrl}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (!(setupRes.status === 201 || setupRes.status === 409)) {
      await parseJsonOrThrow<Record<string, never>>(setupRes);
    }
  }

  const loginRes = await fetch(`${serverUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  const login = await parseJsonOrThrow<LoginResponse>(loginRes);

  const prefs = getCachedPreferences();
  prefs.sync.serverUrl = serverUrl;
  prefs.sync.token = login.token;
  prefs.sync.lastError = '';
  await savePreferences(prefs);
}

export async function saveSyncServerUrl(urlInput: string): Promise<void> {
  const serverUrl = normalizeBaseUrl(urlInput);
  const prefs = getCachedPreferences();
  prefs.sync.serverUrl = serverUrl;
  await savePreferences(prefs);
}

export async function syncNow(): Promise<SyncSummary> {
  const prefs = getCachedPreferences();
  const serverUrl = normalizeBaseUrl(prefs.sync.serverUrl);
  const token = prefs.sync.token;

  if (!serverUrl) throw new Error('Set a sync server URL first');
  if (!token) throw new Error('Connect to server first');

  let state = await loadSyncState();
  const outgoingByUuid = new Map<string, string>();

  // Prepare payload via Rust (parallel file I/O + native SHA-256)
  const prepared = await prepareSyncPayloadRust(state);
  state = prepared.nextState;
  const syncNotes: SyncRequest['notes'] = prepared.notes;
  const allUuids = prepared.allUuids;
  for (const note of syncNotes) {
    outgoingByUuid.set(note.uuid, noteIdFromFilename(note.filename));
  }

  let response: SyncResponse;
  try {
    response = await authPost<SyncResponse>(serverUrl, token, '/sync', {
      notes: syncNotes,
      all_uuids: allUuids,
      deleted_uuids: state.deletedUuids,
    }, { 'X-Client-Id': getClientId() });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setSyncError(message);
    throw e;
  }

  // Apply incoming changes via Rust (parallel file writes + index update)
  const updatedIds = new Set<string>();
  const deletedIds = new Set<string>();
  const updatesForRust = response.update
    .filter((note): note is SyncResponse['update'][number] & { content: string } => typeof note.content === 'string')
    .map((note) => ({
      uuid: note.uuid,
      id: noteIdFromFilename(note.filename),
      content: note.content,
      modified_at: note.modified_at,
      content_hash: note.content_hash,
    }));

  const applied = await applySyncDeltaRust(state, updatesForRust, response.delete);
  state = applied.nextState;
  const downloaded = updatesForRust.length;
  const deleted = applied.deletedIds.length;
  for (const id of applied.updatedIds) updatedIds.add(id);
  for (const id of applied.deletedIds) deletedIds.add(id);

  for (const note of updatesForRust) {
    outgoingByUuid.set(note.uuid, note.id);
  }

  for (const update of response.hash_updates) {
    state.hashByUuid[update.uuid] = update.hash_at_last_sync;
    const id = outgoingByUuid.get(update.uuid) ?? findIdForUuid(state, update.uuid);
    if (id) state.uuidById[id] = update.uuid;
    state.deletedUuids = state.deletedUuids.filter((u) => u !== update.uuid);
  }

  // Clear all deletions that were sent — the server has tombstoned them.
  // Without this, deletedUuids accumulates forever and gets re-sent every sync.
  state.deletedUuids = [];

  await saveSyncState(state);
  if (updatedIds.size > 0 || deletedIds.size > 0) {
    await refreshNotesAfterSync(Array.from(updatedIds), Array.from(deletedIds));
  }
  await clearSyncErrorAndSetTime();

  return {
    uploaded: response.hash_updates.length,
    downloaded,
    deleted,
    conflicts: response.conflicts.length,
    updatedIds: Array.from(updatedIds),
    deletedIds: Array.from(deletedIds),
  };
}

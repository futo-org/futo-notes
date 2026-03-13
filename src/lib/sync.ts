import { sanitizeFilename } from './utils';
import { refreshNotesAfterSync } from './notes';
import { getCachedPreferences, savePreferences } from './preferences';
import { clearSyncState, findIdForUuid, loadSyncState, saveSyncState } from './syncState';
import { getClientId } from './sseClient';
import { applySyncDeltaRust, prepareSyncPayloadRust } from './rustCore';
import { FALLBACK_TITLE, type HealthResponse, type LoginResponse, type SyncCheckResponse, type SyncResponse } from '@futo-notes/shared';

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  updatedIds: string[];
  deletedIds: string[];
  renamed: SyncRename[];
}

export interface SyncRename {
  fromId: string;
  toId: string;
}

function hasPersistedRemoteKnowledge(state: import('./syncState').SyncState): boolean {
  return Object.keys(state.uuidById).length > 0 || Object.keys(state.hashByUuid).length > 0;
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

  // Phase 1: Quick-check — skip full sync if nothing changed
  let state = await loadSyncState();
  const serverVersion = state.serverVersion ?? 0;
  const hasRemoteKnowledge = hasPersistedRemoteKnowledge(state);

  // Always probe when we have evidence of prior sync state. Reset detection needs to
  // run even if local deletions or renames are pending; otherwise a reset can fall
  // through to a full sync with stale UUID/hash metadata and suppress uploads.
  if (serverVersion > 0 || hasRemoteKnowledge) {
    try {
      const check = await authPost<SyncCheckResponse>(serverUrl, token, '/sync/check', { version: serverVersion });
      if (typeof check.version === 'number' && check.version < serverVersion) {
        // The server version moved backwards, which means the server was reset or replaced.
        // Our cached UUID/hash mapping is no longer authoritative, so force a fresh upload.
        await clearSyncState();
        state = await loadSyncState();
      } else if (serverVersion === 0 && hasRemoteKnowledge && check.version === 0) {
        // We have evidence this client synced before, but the server reports a pristine
        // version counter. Treat that as a reset/replacement and rebuild from local files.
        await clearSyncState();
        state = await loadSyncState();
      } else if (check.status === 'up_to_date' && state.deletedUuids.length === 0 && !state.hasPendingRenames) {
        // Still need to check if we have local changes
        const prepared = await prepareSyncPayloadRust(state);
        state = prepared.nextState;
        const hasLocalChanges = prepared.notes.some((n) => n.content !== undefined);
        if (!hasLocalChanges) {
          await saveSyncState(state);
          await clearSyncErrorAndSetTime();
          return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, updatedIds: [], deletedIds: [], renamed: [] };
        }
        // Local changes exist — fall through to full sync with already-prepared payload
        return await doFullSync(serverUrl, token, state, prepared);
      }
      // changes_available — fall through to full sync
    } catch {
      // /sync/check failed (old server?) — fall through to full sync
    }
  }

  // Full sync
  const prepared = await prepareSyncPayloadRust(state);
  state = prepared.nextState;
  return await doFullSync(serverUrl, token, state, prepared);
}

async function doFullSync(
  serverUrl: string,
  token: string,
  state: import('./syncState').SyncState,
  prepared: Awaited<ReturnType<typeof prepareSyncPayloadRust>>,
): Promise<SyncSummary> {
  const outgoingByUuid = new Map<string, string>();

  // Build V2 payload: only send changed notes with content, compact inventory for the rest
  const changedNotes = prepared.notes.filter((n) => n.content !== undefined);
  const inventory = prepared.notes.map((n) => ({
    uuid: n.uuid,
    content_hash: n.content_hash,
    filename: n.filename,
    modified_at: n.modified_at,
  }));

  for (const note of prepared.notes) {
    outgoingByUuid.set(note.uuid, noteIdFromFilename(note.filename));
  }

  let response: SyncResponse;
  try {
    response = await authPost<SyncResponse>(serverUrl, token, '/sync', {
      notes: changedNotes,
      inventory,
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
  state.deletedUuids = [];

  // Save server version for quick-check on next sync
  if (typeof response.version === 'number') {
    state.serverVersion = response.version;
  }
  // Clear rename flag — renames have been synced
  delete state.hasPendingRenames;

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
    renamed: applied.renamed,
  };
}

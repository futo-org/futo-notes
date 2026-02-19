import { sanitizeFilename } from './utils';
import { getAllNotes, getNoteById, readNote, updateNote, deleteNote } from './notes';
import { getCachedPreferences, savePreferences } from './preferences';
import { findIdForUuid, loadSyncState, saveSyncState } from './syncState';
import type { HealthResponse, LoginResponse, SyncRequest, SyncResponse } from '@futo-notes/shared';

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
}

function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

function noteIdFromFilename(filename: string): string {
  const withoutExt = filename.replace(/\.md$/i, '');
  return sanitizeFilename(withoutExt) || 'untitled';
}

function titleFromId(id: string): string {
  return id
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
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

async function authPost<T>(baseUrl: string, token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
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

  const state = await loadSyncState();
  const localNotes = getAllNotes();
  const outgoingByUuid = new Map<string, string>();

  const syncNotes: SyncRequest['notes'] = [];
  for (const note of localNotes) {
    const id = note.id;
    const uuid = state.uuidById[id] ?? id;
    state.uuidById[id] = uuid;
    outgoingByUuid.set(uuid, id);

    const content = await readNote(id);
    const hash = await sha256Hex(content);
    const lastSyncHash = state.hashByUuid[uuid] ?? '';

    syncNotes.push({
      uuid,
      filename: `${id}.md`,
      modified_at: note.modificationTime || Date.now(),
      content_hash: hash,
      hash_at_last_sync: lastSyncHash,
      ...(hash !== lastSyncHash ? { content } : {}),
    });
  }

  let response: SyncResponse;
  try {
    response = await authPost<SyncResponse>(serverUrl, token, '/sync', {
      notes: syncNotes,
      all_uuids: Array.from(outgoingByUuid.keys()),
      deleted_uuids: state.deletedUuids,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setSyncError(message);
    throw e;
  }

  let deleted = 0;
  for (const uuid of response.delete) {
    const id = outgoingByUuid.get(uuid) ?? findIdForUuid(state, uuid);
    if (id && getNoteById(id)) {
      await deleteNote(id, { trackSyncDelete: false });
      deleted++;
    }
    if (id) delete state.uuidById[id];
    delete state.hashByUuid[uuid];
    state.deletedUuids = state.deletedUuids.filter((u) => u !== uuid);
  }

  let downloaded = 0;
  for (const note of response.update) {
    if (typeof note.content !== 'string') continue;

    const incomingId = noteIdFromFilename(note.filename);
    const mappedId = findIdForUuid(state, note.uuid);
    const existingIncoming = getNoteById(incomingId);

    let originalId: string | undefined;
    if (mappedId && mappedId !== incomingId) {
      originalId = mappedId;
    } else if (existingIncoming) {
      originalId = incomingId;
    }

    const result = await updateNote(
      incomingId,
      titleFromId(incomingId),
      note.content,
      originalId,
      note.modified_at,
    );

    if (mappedId && mappedId !== result.id) {
      delete state.uuidById[mappedId];
    }

    state.uuidById[result.id] = note.uuid;
    state.hashByUuid[note.uuid] = note.content_hash;
    state.deletedUuids = state.deletedUuids.filter((u) => u !== note.uuid);
    outgoingByUuid.set(note.uuid, result.id);
    downloaded++;
  }

  for (const update of response.hash_updates) {
    state.hashByUuid[update.uuid] = update.hash_at_last_sync;
    const id = outgoingByUuid.get(update.uuid) ?? findIdForUuid(state, update.uuid);
    if (id) state.uuidById[id] = update.uuid;
    state.deletedUuids = state.deletedUuids.filter((u) => u !== update.uuid);
  }

  await saveSyncState(state);
  await clearSyncErrorAndSetTime();

  return {
    uploaded: response.hash_updates.length,
    downloaded,
    deleted,
    conflicts: response.conflicts.length,
  };
}

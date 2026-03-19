import { sanitizeFilename } from './utils';
import { refreshNotesAfterSync } from './notes';
import { getCachedPreferences, savePreferences } from './preferences';
import { clearSyncState, findIdForUuid, loadSyncState, saveSyncState } from './syncState';
import { getClientId } from './sseClient';
import { applySyncDeltaRust, prepareImageSyncRust, prepareSyncPayloadRust, readImageBytesRust, writeSyncedImageRust, applyImageSyncDeltaRust, hasRustCore } from './rustCore';
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

async function authPutBinary(baseUrl: string, token: string, path: string, data: Uint8Array, headers: Record<string, string>): Promise<void> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body: data as unknown as BodyInit,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Blob upload failed: HTTP ${res.status} ${text}`);
  }
}

async function authGetBinary(baseUrl: string, token: string, path: string): Promise<number[]> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Blob download failed: HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  return Array.from(new Uint8Array(buf));
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

  // ── Phase 0: Prepare image inventory via Rust ──────────
  let imageInventory: import('./rustCore').ImageSyncEntry[] = [];
  if (hasRustCore()) {
    try {
      const imagePrep = await prepareImageSyncRust(state);
      state = imagePrep.nextState;
      imageInventory = imagePrep.images;
    } catch {
      // Image sync not available (e.g. old binary) — continue without
    }
  }

  // ── Phase 1: Upload new/changed images ─────────────────
  const changedImages = imageInventory.filter((img) => img.content_hash !== img.hash_at_last_sync);
  for (const img of changedImages) {
    try {
      const bytes = await readImageBytesRust(img.filename);
      await authPutBinary(serverUrl, token, `/sync/blob/${img.uuid}`, new Uint8Array(bytes), {
        'X-Filename': img.filename,
        'X-Modified-At': String(img.modified_at),
      });
    } catch {
      // Skip individual image upload failures — don't block note sync
    }
  }

  // ── Phase 2: Main sync (merge image entries) ───────────
  // Build V2 payload: only send changed notes with content, compact inventory for the rest
  const changedNotes = prepared.notes.filter((n) => n.content !== undefined);

  // Include image entries in notes[] and inventory[]
  const imageNotes = changedImages.map((img) => ({
    uuid: img.uuid,
    filename: img.filename,
    modified_at: img.modified_at,
    content_hash: img.content_hash,
    hash_at_last_sync: img.hash_at_last_sync,
    is_blob: true as const,
  }));

  const imageInventoryItems = imageInventory.map((img) => ({
    uuid: img.uuid,
    content_hash: img.content_hash,
    filename: img.filename,
    modified_at: img.modified_at,
  }));

  const inventory = [
    ...prepared.notes.map((n) => ({
      uuid: n.uuid,
      content_hash: n.content_hash,
      filename: n.filename,
      modified_at: n.modified_at,
    })),
    ...imageInventoryItems,
  ];

  for (const note of prepared.notes) {
    outgoingByUuid.set(note.uuid, noteIdFromFilename(note.filename));
  }
  for (const img of imageInventory) {
    outgoingByUuid.set(img.uuid, img.filename);
  }

  let response: SyncResponse;
  try {
    response = await authPost<SyncResponse>(serverUrl, token, '/sync', {
      notes: [...changedNotes, ...imageNotes],
      inventory,
      deleted_uuids: state.deletedUuids,
    }, { 'X-Client-Id': getClientId() });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setSyncError(message);
    throw e;
  }

  // Apply incoming note changes via Rust (parallel file writes + index update)
  const updatedIds = new Set<string>();
  const deletedIds = new Set<string>();
  const updatesForRust = response.update
    .filter((note): note is SyncResponse['update'][number] & { content: string } => typeof note.content === 'string' && !note.is_blob)
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

  // ── Phase 3: Download images from response ─────────────
  const blobUpdates = response.update.filter((u) => u.is_blob);
  if (hasRustCore() && blobUpdates.length > 0) {
    for (const blob of blobUpdates) {
      try {
        const data = await authGetBinary(serverUrl, token, `/sync/blob/${blob.uuid}`);
        await writeSyncedImageRust(blob.filename, data, blob.modified_at);
        // Update sync state for downloaded image
        state.uuidById[blob.filename] = blob.uuid;
        state.hashByUuid[blob.uuid] = blob.content_hash;
      } catch {
        // Skip individual image download failures
      }
    }

    // Handle image deletions
    const blobDeletes = response.delete.filter((uuid) => {
      const filename = findIdForUuid(state, uuid);
      return filename && !filename.endsWith('.md');
    });
    if (blobDeletes.length > 0) {
      const imgDelta = await applyImageSyncDeltaRust(state, blobDeletes);
      state = imgDelta.nextState;
    }
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
    downloaded: downloaded + blobUpdates.length,
    deleted,
    conflicts: response.conflicts.length,
    updatedIds: Array.from(updatedIds),
    deletedIds: Array.from(deletedIds),
    renamed: applied.renamed,
  };
}

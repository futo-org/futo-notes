import { getCachedPreferences, savePreferences, loadV2SyncState, saveV2SyncState, clearV2SyncState, type V2SyncState } from './appState';
import { prepareSyncPayloadV2, applySyncDeltaV2, hasRustCore } from './rustCore';

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  updatedIds: string[];
  deletedIds: string[];
  renamed: Array<{ fromId: string; toId: string }>;
}

const SYNC_TIMEOUT_MS = 120_000;

function normalizeBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url;
}

function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
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
  const res = await fetchWithTimeout(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return parseJsonOrThrow<T>(res);
}

interface SyncCheckResponse {
  status: 'up_to_date' | 'changes_available';
  version: number;
}

interface V2SyncResponse {
  update: { filename: string; content: string; hash: string; modified_at: number }[];
  delete: string[];
  conflicts: { filename: string; content: string }[];
  version: number;
  timestamps: Record<string, number>;
}

function stripMdExtension(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

export function deriveRemoteRenames(params: {
  previousFileHashes: Record<string, string>;
  updates: Array<{ filename: string; hash: string }>;
  deletes: string[];
}): Array<{ fromId: string; toId: string }> {
  const updatesByHash = new Map<string, string[]>();
  for (const update of params.updates) {
    if (!update.filename.endsWith('.md')) continue;
    const matching = updatesByHash.get(update.hash);
    if (matching) {
      matching.push(update.filename);
    } else {
      updatesByHash.set(update.hash, [update.filename]);
    }
  }

  const renamed: Array<{ fromId: string; toId: string }> = [];
  const consumedTargets = new Set<string>();

  for (const deletedFilename of params.deletes) {
    if (!deletedFilename.endsWith('.md')) continue;
    const previousHash = params.previousFileHashes[deletedFilename];
    if (!previousHash) continue;

    const candidates = updatesByHash.get(previousHash);
    if (!candidates) continue;

    const nextFilename = candidates.find((candidate) => candidate !== deletedFilename && !consumedTargets.has(candidate));
    if (!nextFilename) continue;

    consumedTargets.add(nextFilename);
    renamed.push({
      fromId: stripMdExtension(deletedFilename),
      toId: stripMdExtension(nextFilename),
    });
  }

  return renamed;
}

export interface HealthResponse {
  status: string;
  setup_complete: boolean;
}

export interface LoginResponse {
  token: string;
}

export async function connectSyncServerV2(urlInput: string, password: string): Promise<void> {
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

  // Clear stale sync state so the first sync with the new server
  // treats every local note as "new" and uploads it.
  await clearV2SyncState();
}

export async function syncNowV2(): Promise<SyncSummary> {
  const prefs = getCachedPreferences();
  const serverUrl = normalizeBaseUrl(prefs.sync.serverUrl);
  const token = prefs.sync.token;

  if (!serverUrl) throw new Error('Set a sync server URL first');
  if (!token) throw new Error('Connect to server first');
  if (!hasRustCore()) throw new Error('V2 sync requires Tauri runtime');

  let syncState = await loadV2SyncState();

  // Quick-check: skip full sync if nothing changed
  if (syncState.lastServerVersion > 0) {
    try {
      const check = await authPost<SyncCheckResponse>(serverUrl, token, '/sync/check', {
        version: syncState.lastServerVersion,
      });

      // Server version went backwards — server was reset; force a full rescan
      if (typeof check.version === 'number' && check.version < syncState.lastServerVersion) {
        syncState.lastServerVersion = 0;
        syncState.fileHashes = {};
        // Fall through to full sync below
      } else if (check.status === 'up_to_date') {
        // Still check for local changes
        const prepared = await prepareSyncPayloadV2(syncState);
        syncState = prepared.nextState;
        const hasLocalChanges =
          prepared.changed.length > 0 || prepared.new.length > 0 || prepared.deleted.length > 0;
        if (!hasLocalChanges) {
          await saveV2SyncState(syncState);
          await clearSyncErrorAndSetTime();
          return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, updatedIds: [], deletedIds: [], renamed: [] };
        }
        // Local changes — fall through to full sync with prepared payload
        return doFullSyncV2(serverUrl, token, syncState, prepared);
      }
    } catch {
      // sync/check failed — fall through to full sync
    }
  }

  // Full sync
  const prepared = await prepareSyncPayloadV2(syncState);
  syncState = prepared.nextState;
  return doFullSyncV2(serverUrl, token, syncState, prepared);
}

async function doFullSyncV2(
  serverUrl: string,
  token: string,
  syncState: V2SyncState,
  prepared: Awaited<ReturnType<typeof prepareSyncPayloadV2>>,
): Promise<SyncSummary> {
  const previousFileHashes = syncState.fileHashes;

  // Send sync request
  const response = await authPost<V2SyncResponse>(serverUrl, token, '/sync', {
    device_id: syncState.deviceId,
    inventory: prepared.inventory,
    changed: prepared.changed,
    new: prepared.new,
    deleted: prepared.deleted,
  });

  // Filter out non-markdown (blob) updates — blobs are fetched via GET /blob/{filename}
  const mdUpdates = response.update.filter((u) => u.filename.endsWith('.md'));
  const mdDeletes = response.delete.filter((d) => d.endsWith('.md'));

  // Apply server response via Rust (writes/deletes files, updates search index, corrects mtimes)
  const hasNoteChanges = mdUpdates.length > 0 || mdDeletes.length > 0 || response.conflicts.length > 0;
  const applied = hasNoteChanges
    ? await applySyncDeltaV2(mdUpdates, mdDeletes, response.conflicts, response.timestamps ?? {})
    : { updatedFilenames: [] as string[], deletedFilenames: [] as string[], conflictFilenames: [] as string[], elapsedMs: 0 };

  // Update file hashes to reflect post-sync state
  const newFileHashes: Record<string, string> = { ...syncState.fileHashes };

  // Remove deleted files
  for (const filename of response.delete) {
    delete newFileHashes[filename];
  }
  for (const filename of prepared.deleted) {
    delete newFileHashes[filename];
  }

  // Add/update from server updates
  for (const update of response.update) {
    newFileHashes[update.filename] = update.hash;
  }

  // Add/update from client changes that were accepted
  for (const changed of prepared.changed) {
    if (!response.update.some((u) => u.filename === changed.filename)) {
      newFileHashes[changed.filename] = changed.hash;
    }
  }
  for (const newNote of prepared.new) {
    newFileHashes[newNote.filename] = newNote.hash;
  }

  // Add conflict copies
  for (const conflict of response.conflicts) {
    const hash = await computeHash(conflict.content);
    newFileHashes[conflict.filename] = hash;
  }

  syncState.fileHashes = newFileHashes;
  syncState.lastServerVersion = response.version;
  await saveV2SyncState(syncState);
  await clearSyncErrorAndSetTime();

  const renamed = deriveRemoteRenames({
    previousFileHashes,
    updates: mdUpdates,
    deletes: mdDeletes,
  });
  const renamedFromIds = new Set(renamed.map((entry) => entry.fromId));
  const renamedToIds = new Set(renamed.map((entry) => entry.toId));
  const updatedIds = applied.updatedFilenames
    .map((f) => stripMdExtension(f))
    .filter((id) => !renamedToIds.has(id));
  const deletedIds = applied.deletedFilenames
    .map((f) => stripMdExtension(f))
    .filter((id) => !renamedFromIds.has(id));

  return {
    uploaded: prepared.changed.length + prepared.new.length,
    downloaded: response.update.length,
    deleted: response.delete.length + prepared.deleted.length,
    conflicts: response.conflicts.length,
    updatedIds,
    deletedIds,
    renamed,
  };
}

async function computeHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function clearSyncErrorAndSetTime(): Promise<void> {
  const prefs = getCachedPreferences();
  prefs.sync.lastError = '';
  prefs.sync.lastSyncedAt = Date.now();
  await savePreferences(prefs);
}

export async function saveSyncServerUrl(urlInput: string): Promise<void> {
  const { updateAppState } = await import('./appState');
  await updateAppState({ serverUrl: normalizeBaseUrl(urlInput) });
}

/** Quick version check without doing a full sync. */
export async function checkForChangesV2(): Promise<boolean> {
  const prefs = getCachedPreferences();
  const serverUrl = normalizeBaseUrl(prefs.sync.serverUrl);
  const token = prefs.sync.token;
  if (!serverUrl || !token) return false;

  const syncState = await loadV2SyncState();
  try {
    const check = await authPost<SyncCheckResponse>(serverUrl, token, '/sync/check', {
      version: syncState.lastServerVersion,
    });
    return check.status === 'changes_available';
  } catch {
    return false;
  }
}

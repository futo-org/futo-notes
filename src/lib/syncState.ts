import { persistedJson } from './persistedJson';

export interface SyncState {
  hashByUuid: Record<string, string>;
  uuidById: Record<string, string>;
  deletedUuids: string[];
  /** Cache of content hashes by noteId, keyed on modificationTime to avoid re-reading unchanged files */
  hashCache?: Record<string, { modifiedAt: number; hash: string }>;
  /** Monotonic server version — used to skip no-op syncs via /sync/check. */
  serverVersion?: number;
  /** Set when a local rename hasn't been synced yet (quick-check must not skip). */
  hasPendingRenames?: boolean;
}

function cloneDefault(): SyncState {
  return {
    hashByUuid: {},
    uuidById: {},
    deletedUuids: [],
  };
}

function sanitizeState(raw: unknown): SyncState {
  if (!raw || typeof raw !== 'object') return cloneDefault();
  const obj = raw as Record<string, unknown>;

  const hashByUuid =
    obj.hashByUuid && typeof obj.hashByUuid === 'object'
      ? (Object.fromEntries(
          Object.entries(obj.hashByUuid as Record<string, unknown>).filter(
            ([k, v]) => typeof k === 'string' && typeof v === 'string'
          )
        ) as Record<string, string>)
      : {};

  const uuidById =
    obj.uuidById && typeof obj.uuidById === 'object'
      ? (Object.fromEntries(
          Object.entries(obj.uuidById as Record<string, unknown>).filter(
            ([k, v]) => typeof k === 'string' && typeof v === 'string'
          )
        ) as Record<string, string>)
      : {};

  const deletedUuids = Array.isArray(obj.deletedUuids)
    ? obj.deletedUuids.filter((x): x is string => typeof x === 'string')
    : [];

  let hashCache: Record<string, { modifiedAt: number; hash: string }> | undefined;
  if (obj.hashCache && typeof obj.hashCache === 'object') {
    hashCache = {};
    for (const [k, v] of Object.entries(obj.hashCache as Record<string, unknown>)) {
      if (v && typeof v === 'object' && 'modifiedAt' in v && 'hash' in v) {
        const entry = v as Record<string, unknown>;
        if (typeof entry.modifiedAt === 'number' && typeof entry.hash === 'string') {
          hashCache[k] = { modifiedAt: entry.modifiedAt, hash: entry.hash };
        }
      }
    }
  }

  const serverVersion = typeof obj.serverVersion === 'number' ? obj.serverVersion : undefined;
  const hasPendingRenames = obj.hasPendingRenames === true ? true : undefined;

  return {
    hashByUuid, uuidById, deletedUuids, hashCache,
    ...(serverVersion !== undefined ? { serverVersion } : {}),
    ...(hasPendingRenames ? { hasPendingRenames } : {}),
  };
}

const store = persistedJson<SyncState>({
  path: '.sync-state-v1.json',
  defaultValue: cloneDefault,
  validate: sanitizeState,
  cache: true,
  cloneOnRead: true,
});

export async function loadSyncState(): Promise<SyncState> {
  return store.load();
}

export async function saveSyncState(state: SyncState): Promise<void> {
  return store.save(state);
}

export function findIdForUuid(state: SyncState, uuid: string): string | null {
  for (const [id, mappedUuid] of Object.entries(state.uuidById)) {
    if (mappedUuid === uuid) return id;
  }
  return null;
}

export async function markLocalDeleteForSync(id: string): Promise<void> {
  const state = await loadSyncState();
  const uuid = state.uuidById[id] ?? id;
  if (!state.deletedUuids.includes(uuid)) {
    state.deletedUuids.push(uuid);
  }
  delete state.uuidById[id];
  delete state.hashByUuid[uuid];
  await saveSyncState(state);
}

export async function trackLocalRenameForSync(oldId: string, newId: string): Promise<void> {
  const state = await loadSyncState();
  const uuid = state.uuidById[oldId];
  if (!uuid) return;
  state.uuidById[newId] = uuid;
  delete state.uuidById[oldId];
  state.hasPendingRenames = true;
  await saveSyncState(state);
}

export async function clearDeletedUuid(uuid: string): Promise<void> {
  const state = await loadSyncState();
  state.deletedUuids = state.deletedUuids.filter((u) => u !== uuid);
  await saveSyncState(state);
}

export async function clearSyncState(): Promise<void> {
  await store.save(cloneDefault());
}

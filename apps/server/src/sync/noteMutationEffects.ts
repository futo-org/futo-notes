import type Database from 'better-sqlite3';
import { incrementSyncVersion } from '../db/syncVersion.js';
import { createTombstone } from '../db/tombstones.js';
import { broadcastSyncAvailable } from '../events.js';
import { markDirtyAfterSync, removeDirtyForDeleted } from '../search/dirtyTracker.js';

export interface NoteMutationEffectsInput {
  changedUuids?: string[];
  deletedUuids?: string[];
  notifyClients?: boolean;
  excludeClientId?: string;
  incrementVersion?: boolean;
  searchEnabled: boolean;
}

export function applyNoteMutationEffects(
  db: Database.Database,
  {
    changedUuids = [],
    deletedUuids = [],
    notifyClients = false,
    excludeClientId,
    incrementVersion = false,
    searchEnabled,
  }: NoteMutationEffectsInput,
): number | null {
  const uniqueChangedUuids = Array.from(new Set(changedUuids));
  const uniqueDeletedUuids = Array.from(new Set(deletedUuids));
  const hasMutations = uniqueChangedUuids.length > 0 || uniqueDeletedUuids.length > 0;

  if (!hasMutations) {
    return null;
  }

  let version: number | null = null;
  if (incrementVersion) {
    version = incrementSyncVersion(db);
  }

  if (searchEnabled) {
    if (uniqueChangedUuids.length > 0) {
      markDirtyAfterSync(db, uniqueChangedUuids);
    }
    if (uniqueDeletedUuids.length > 0) {
      removeDirtyForDeleted(db, uniqueDeletedUuids);
    }
  }

  if (uniqueDeletedUuids.length > 0) {
    for (const uuid of uniqueDeletedUuids) {
      createTombstone(db, uuid);
    }
  }

  if (notifyClients) {
    broadcastSyncAvailable(excludeClientId);
  }

  return version;
}

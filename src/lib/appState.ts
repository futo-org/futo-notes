/**
 * Unified app state — single `.app-state.json` in the app data directory.
 *
 * Combines sync credentials (previously in .preferences.json), sync state
 * (previously in .sync-state-v2.json), and user preferences into one file.
 *
 * On first load, migrates from the legacy files if `.app-state.json`
 * doesn't exist. Legacy files are left in place for safety.
 */

import { getPlatformFS, hasFileSystem } from './platform';

// ── Types ──────────────────────────────────────────────────────────────

export interface AppState {
  // Sync credentials
  serverUrl: string;
  authToken: string;

  // Sync state
  deviceId: string;
  lastServerVersion: number;
  fileHashes: Record<string, string>;

  // User preferences
  preferences: {
    theme: 'auto' | 'dark' | 'light';
    sortOrder: string;
  };

  // Crash reporting
  crashReporting: {
    enabled: boolean;
    alwaysSend: boolean;
  };

  // Ephemeral sync metadata (not critical — rebuilt on next sync)
  lastSyncedAt: number | null;
  lastSyncError: string;
  hashCache?: Record<string, { modifiedAt: number; hash: string }>;

  // Dirty journal: files changed/deleted locally since last successful sync
  dirtyUpserts?: string[];
  dirtyDeletes?: string[];

  // Cached graph layout from server
  graphLayout?: {
    serverVersion: number;
    data: ServerGraphLayout;
  };
}

/** Raw shape returned by GET /graph/layout on the V2 server. */
export interface ServerGraphLayout {
  nodes: Array<{ filename: string; x: number; y: number; cluster_index: number }>;
  clusters: Array<{
    index: number;
    label: string;
    center_x: number;
    center_y: number;
    radius: number;
    color_index: number;
    filenames: string[];
  }>;
  note_count: number;
  indexed_count: number;
}

const APP_STATE_PATH = '.app-state.json';
const LEGACY_PREFS_PATH = '.preferences.json';
const LEGACY_SYNC_STATE_PATH = '.sync-state-v2.json';

// ── Defaults ───────────────────────────────────────────────────────────

function generateDeviceId(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

function defaultState(): AppState {
  // Dev builds default to the local sync server so first-run developer
  // experience works without manually configuring a URL. Release builds
  // start empty and require an explicit server choice.
  const devServerUrl = import.meta.env.DEV ? 'http://localhost:3005' : '';
  return {
    serverUrl: devServerUrl,
    authToken: '',
    deviceId: generateDeviceId(),
    lastServerVersion: 0,
    fileHashes: {},
    preferences: {
      theme: 'auto',
      sortOrder: 'modified',
    },
    crashReporting: {
      enabled: true,
      alwaysSend: false,
    },
    lastSyncedAt: null,
    lastSyncError: '',
  };
}

// ── In-memory cache ────────────────────────────────────────────────────

let cached: AppState | null = null;

// ── Sanitization ───────────────────────────────────────────────────────

function sanitize(raw: unknown): AppState {
  const defaults = defaultState();
  if (!raw || typeof raw !== 'object') return defaults;
  const obj = raw as Record<string, unknown>;

  const deviceId =
    typeof obj.deviceId === 'string' && obj.deviceId.length > 0
      ? obj.deviceId
      : defaults.deviceId;

  const fileHashes =
    obj.fileHashes && typeof obj.fileHashes === 'object'
      ? (Object.fromEntries(
          Object.entries(obj.fileHashes as Record<string, unknown>).filter(
            ([, v]) => typeof v === 'string',
          ),
        ) as Record<string, string>)
      : {};

  let hashCache: AppState['hashCache'];
  if (obj.hashCache && typeof obj.hashCache === 'object') {
    const entries = Object.entries(obj.hashCache as Record<string, unknown>)
      .filter(([, v]) => {
        if (!v || typeof v !== 'object') return false;
        const entry = v as Record<string, unknown>;
        return typeof entry.modifiedAt === 'number' && typeof entry.hash === 'string';
      })
      .map(([k, v]) => {
        const entry = v as { modifiedAt: number; hash: string };
        return [k, { modifiedAt: entry.modifiedAt, hash: entry.hash }] as const;
      });
    if (entries.length > 0) hashCache = Object.fromEntries(entries);
  }

  const rawPrefs = (obj.preferences && typeof obj.preferences === 'object'
    ? obj.preferences
    : {}) as Record<string, unknown>;

  const rawCrash = (obj.crashReporting && typeof obj.crashReporting === 'object'
    ? obj.crashReporting
    : {}) as Record<string, unknown>;

  return {
    serverUrl: typeof obj.serverUrl === 'string' ? obj.serverUrl : '',
    authToken: typeof obj.authToken === 'string' ? obj.authToken : '',
    deviceId,
    lastServerVersion:
      typeof obj.lastServerVersion === 'number' ? obj.lastServerVersion : 0,
    fileHashes,
    preferences: {
      theme: ['auto', 'dark', 'light'].includes(rawPrefs.theme as string)
        ? (rawPrefs.theme as 'auto' | 'dark' | 'light')
        : 'auto',
      sortOrder: typeof rawPrefs.sortOrder === 'string' ? rawPrefs.sortOrder : 'modified',
    },
    crashReporting: {
      enabled: typeof rawCrash.enabled === 'boolean' ? rawCrash.enabled : true,
      alwaysSend: typeof rawCrash.alwaysSend === 'boolean' ? rawCrash.alwaysSend : false,
    },
    lastSyncedAt: typeof obj.lastSyncedAt === 'number' ? obj.lastSyncedAt : null,
    lastSyncError: typeof obj.lastSyncError === 'string' ? obj.lastSyncError : '',
    ...(hashCache ? { hashCache } : {}),
    ...(obj.graphLayout && typeof obj.graphLayout === 'object'
      ? { graphLayout: obj.graphLayout as AppState['graphLayout'] }
      : {}),
  };
}

// ── Migration from legacy files ────────────────────────────────────────

async function migrateFromLegacy(): Promise<AppState | null> {
  if (!hasFileSystem) return null;
  const fs = await getPlatformFS();

  let migrated = false;
  const state = defaultState();

  // Try legacy preferences
  try {
    const prefsData = await fs.readAppData(LEGACY_PREFS_PATH);
    if (prefsData) {
      const prefs = JSON.parse(prefsData);
      if (prefs.appearance?.theme) state.preferences.theme = prefs.appearance.theme;
      if (prefs.crashReporting) {
        if (typeof prefs.crashReporting.enabled === 'boolean')
          state.crashReporting.enabled = prefs.crashReporting.enabled;
        if (typeof prefs.crashReporting.alwaysSend === 'boolean')
          state.crashReporting.alwaysSend = prefs.crashReporting.alwaysSend;
      }
      if (prefs.sync) {
        if (typeof prefs.sync.serverUrl === 'string') state.serverUrl = prefs.sync.serverUrl;
        if (typeof prefs.sync.token === 'string') state.authToken = prefs.sync.token;
        if (typeof prefs.sync.lastSyncedAt === 'number') state.lastSyncedAt = prefs.sync.lastSyncedAt;
        if (typeof prefs.sync.lastError === 'string') state.lastSyncError = prefs.sync.lastError;
      }
      migrated = true;
    }
  } catch {
    // Ignore
  }

  // Try legacy sync state
  try {
    const syncData = await fs.readAppData(LEGACY_SYNC_STATE_PATH);
    if (syncData) {
      const syncState = JSON.parse(syncData);
      if (typeof syncState.deviceId === 'string' && syncState.deviceId.length > 0)
        state.deviceId = syncState.deviceId;
      if (typeof syncState.lastServerVersion === 'number')
        state.lastServerVersion = syncState.lastServerVersion;
      if (syncState.fileHashes && typeof syncState.fileHashes === 'object')
        state.fileHashes = syncState.fileHashes;
      if (syncState.hashCache && typeof syncState.hashCache === 'object')
        state.hashCache = syncState.hashCache;
      migrated = true;
    }
  } catch {
    // Ignore
  }

  return migrated ? state : null;
}

// ── Public API ─────────────────────────────────────────────────────────

export async function loadAppState(): Promise<AppState> {
  if (cached) return cached;

  if (!hasFileSystem) {
    cached = defaultState();
    return cached;
  }

  const fs = await getPlatformFS();

  // Try the new unified file
  try {
    const data = await fs.readAppData(APP_STATE_PATH);
    if (data) {
      cached = sanitize(JSON.parse(data));
      return cached;
    }
  } catch {
    // File corrupt or missing — try migration
  }

  // Try migrating from legacy files
  const migrated = await migrateFromLegacy();
  if (migrated) {
    cached = migrated;
    // Persist the migrated state to the new file
    await saveAppState(migrated);
    return cached;
  }

  // Fresh install
  cached = defaultState();
  return cached;
}

export function getAppState(): AppState {
  if (cached) return cached;
  return defaultState();
}

export async function saveAppState(state: AppState): Promise<void> {
  cached = state;
  if (!hasFileSystem) return;
  const fs = await getPlatformFS();
  await fs.writeAppData(APP_STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Update specific fields of app state (shallow merge at top level).
 * Convenience for callers that only need to change a few fields.
 */
export async function updateAppState(
  updates: Partial<Pick<AppState, 'serverUrl' | 'authToken' | 'lastSyncedAt' | 'lastSyncError' | 'lastServerVersion' | 'fileHashes' | 'hashCache' | 'preferences' | 'crashReporting' | 'graphLayout'>>,
): Promise<void> {
  const current = getAppState();
  const next = { ...current, ...updates };
  await saveAppState(next);
}

// ── Preferences (formerly preferences.ts facade) ──────────────────────

export interface AppPreferences {
  appearance: {
    theme: 'auto' | 'dark' | 'light';
  };
  crashReporting: {
    enabled: boolean;
    alwaysSend: boolean;
  };
  sync: {
    serverUrl: string;
    token: string;
    lastSyncedAt: number | null;
    lastError: string;
  };
}

function stateToPrefs(): AppPreferences {
  const s = getAppState();
  return {
    appearance: { theme: s.preferences.theme },
    crashReporting: { ...s.crashReporting },
    sync: {
      serverUrl: s.serverUrl,
      token: s.authToken,
      lastSyncedAt: s.lastSyncedAt,
      lastError: s.lastSyncError,
    },
  };
}

export async function loadPreferences(): Promise<AppPreferences> {
  await loadAppState();
  return stateToPrefs();
}

export function getCachedPreferences(): AppPreferences {
  return stateToPrefs();
}

export async function savePreferences(prefs: AppPreferences): Promise<void> {
  await updateAppState({
    preferences: { ...getAppState().preferences, theme: prefs.appearance.theme },
    crashReporting: prefs.crashReporting,
    serverUrl: prefs.sync.serverUrl,
    authToken: prefs.sync.token,
    lastSyncedAt: prefs.sync.lastSyncedAt,
    lastSyncError: prefs.sync.lastError,
  });
}

// ── V2 Sync State (formerly v2SyncState.ts facade) ────────────────────

export interface V2SyncState {
  deviceId: string;
  lastServerVersion: number;
  fileHashes: Record<string, string>;
  hashCache?: Record<string, { modifiedAt: number; hash: string }>;
  /** Dirty journal: filenames upserted locally since last sync. */
  dirtyUpserts?: string[];
  /** Dirty journal: filenames deleted locally since last sync. */
  dirtyDeletes?: string[];
}

export async function loadV2SyncState(): Promise<V2SyncState> {
  await loadAppState();
  const s = getAppState();
  return {
    deviceId: s.deviceId,
    lastServerVersion: s.lastServerVersion,
    fileHashes: s.fileHashes,
    ...(s.hashCache ? { hashCache: s.hashCache } : {}),
    ...(s.dirtyUpserts?.length ? { dirtyUpserts: s.dirtyUpserts } : {}),
    ...(s.dirtyDeletes?.length ? { dirtyDeletes: s.dirtyDeletes } : {}),
  };
}

export async function saveV2SyncState(state: V2SyncState): Promise<void> {
  const current = getAppState();
  await saveAppState({
    ...current,
    deviceId: state.deviceId,
    lastServerVersion: state.lastServerVersion,
    fileHashes: state.fileHashes,
    hashCache: state.hashCache,
    dirtyUpserts: state.dirtyUpserts?.length ? state.dirtyUpserts : undefined,
    dirtyDeletes: state.dirtyDeletes?.length ? state.dirtyDeletes : undefined,
  });
}

export async function clearV2SyncState(): Promise<void> {
  await updateAppState({
    lastServerVersion: 0,
    fileHashes: {},
    hashCache: undefined,
  });
}

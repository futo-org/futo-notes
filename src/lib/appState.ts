/**
 * Unified app state — single `.app-state.json` in the app data directory.
 *
 * Combines sync credentials, device identity, and user preferences into one
 * file. On first load, migrates from a legacy `.preferences.json` if it
 * exists. The legacy file is left in place for safety.
 */

import { getPlatformFS, hasFileSystem } from './platform';

// ── Types ──────────────────────────────────────────────────────────────

export interface AppState {
  deviceId: string;

  preferences: {
    theme: 'auto' | 'dark' | 'light';
    sortOrder: string;
  };

  crashReporting: {
    enabled: boolean;
    alwaysSend: boolean;
  };

  lastSyncedAt: number | null;
  lastSyncError: string;

  // E2EE sync state
  e2eeServerUrl?: string;
  e2eeAuthToken?: string;
  e2eeUserId?: string;
  e2eeCollectionId?: string;
  e2eeSalt?: string;
  e2eeObjectMap?: Record<string, {
    objectId: string;
    version: number;
    blobKey: string;
    hash?: string;
    /** Plaintext common ancestor used for client-side three-way conflict merges. */
    baseContent?: string;
    /**
     * On-disk mtime+size at the time of the last successful push. Used as
     * a fast pre-filter in pushE2ee: if both match the current file, skip
     * the read + sha256 entirely. Missing on old entries written before
     * this field was introduced — those fall through to the full
     * read-and-hash path, which restamps them on their next push.
     */
    mtimeMs?: number;
    sizeBytes?: number;
  }>;
  e2eeMaxVersion?: number;
}

const APP_STATE_PATH = '.app-state.json';
const LEGACY_PREFS_PATH = '.preferences.json';

// ── Defaults ───────────────────────────────────────────────────────────

function generateDeviceId(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

function defaultState(): AppState {
  return {
    deviceId: generateDeviceId(),
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

  const rawPrefs = (obj.preferences && typeof obj.preferences === 'object'
    ? obj.preferences
    : {}) as Record<string, unknown>;

  const rawCrash = (obj.crashReporting && typeof obj.crashReporting === 'object'
    ? obj.crashReporting
    : {}) as Record<string, unknown>;

  return {
    deviceId,
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
    // E2EE state — passthrough with type guards
    ...(typeof obj.e2eeServerUrl === 'string' ? { e2eeServerUrl: obj.e2eeServerUrl } : {}),
    ...(typeof obj.e2eeAuthToken === 'string' ? { e2eeAuthToken: obj.e2eeAuthToken } : {}),
    ...(typeof obj.e2eeUserId === 'string' ? { e2eeUserId: obj.e2eeUserId } : {}),
    ...(typeof obj.e2eeCollectionId === 'string' ? { e2eeCollectionId: obj.e2eeCollectionId } : {}),
    ...(typeof obj.e2eeSalt === 'string' ? { e2eeSalt: obj.e2eeSalt } : {}),
    ...(obj.e2eeObjectMap && typeof obj.e2eeObjectMap === 'object'
      ? { e2eeObjectMap: obj.e2eeObjectMap as AppState['e2eeObjectMap'] }
      : {}),
    ...(typeof obj.e2eeMaxVersion === 'number' ? { e2eeMaxVersion: obj.e2eeMaxVersion } : {}),
  };
}

// ── Migration from legacy files ────────────────────────────────────────

async function migrateFromLegacy(): Promise<AppState | null> {
  if (!hasFileSystem) return null;
  const fs = await getPlatformFS();

  const state = defaultState();
  let migrated = false;

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
        if (typeof prefs.sync.lastSyncedAt === 'number') state.lastSyncedAt = prefs.sync.lastSyncedAt;
        if (typeof prefs.sync.lastError === 'string') state.lastSyncError = prefs.sync.lastError;
      }
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

  try {
    const data = await fs.readAppData(APP_STATE_PATH);
    if (data) {
      cached = sanitize(JSON.parse(data));
      return cached;
    }
  } catch {
    // File corrupt or missing — try migration
  }

  const migrated = await migrateFromLegacy();
  if (migrated) {
    cached = migrated;
    await saveAppState(migrated);
    return cached;
  }

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
  await fs.writeAppData(APP_STATE_PATH, JSON.stringify(state));
}

export async function updateAppState(
  updates: Partial<Pick<AppState, 'lastSyncedAt' | 'lastSyncError' | 'preferences' | 'crashReporting' | 'e2eeServerUrl' | 'e2eeAuthToken' | 'e2eeUserId' | 'e2eeCollectionId' | 'e2eeSalt' | 'e2eeObjectMap' | 'e2eeMaxVersion'>>,
): Promise<void> {
  const current = getAppState();
  const next = { ...current, ...updates };
  await saveAppState(next);
}

// ── Preferences facade ────────────────────────────────────────────────

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
      serverUrl: s.e2eeServerUrl ?? '',
      token: s.e2eeAuthToken ?? '',
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
    lastSyncedAt: prefs.sync.lastSyncedAt,
    lastSyncError: prefs.sync.lastError,
  });
}

/**
 * Unified app state — single `.app-state.json`, resolved under the notes
 * root (see `readAppData`/`writeAppData` in `platform/tauri.ts`).
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

  updates: {
    enabled: boolean;
  };

  lastSyncedAt: number | null;
  lastSyncError: string;

  // E2EE sync state
  e2eeServerUrl?: string;
  e2eeAuthToken?: string;
  e2eeUserId?: string;
  e2eeCollectionId?: string;
  e2eeSalt?: string;
  // The vault password is NEVER stored here. It used to live in plaintext as
  // `e2eePassword` (F6) — any vault backup/Syncthing/Dropbox/`git init` leaked
  // it. It now lives in the OS keyring, owned by `syncServiceE2ee.ts` via the
  // `e2ee_password_*` Tauri commands. `sanitize()` drops any legacy field so a
  // pre-migration file can never re-persist it (see `getLegacyE2eePassword`).
  /**
   * Non-secret marker: a disconnect / "forget password" / Full reset could not
   * reach the keyring to delete the stored vault password, so an orphaned OS
   * credential remains. `syncServiceE2ee.initSyncPassword()` retries the delete
   * on the next launch and clears this once it succeeds (K3). Never holds the
   * password itself — only the fact that a deletion is outstanding.
   */
  pendingKeyringDeletion?: boolean;
  // E2EE bookkeeping (`e2eeObjectMap`, `e2eeMaxVersion`) lives in
  // `.e2ee-state.json` owned by Rust now. Legacy values in a pre-port
  // `.app-state.json` are imported by Rust on first connect; until then they are
  // held over (see `legacySyncState`) and re-injected on every save so they are
  // NOT scrubbed prematurely — only after the import persists `.e2ee-state.json`.
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
    updates: {
      enabled: true,
    },
    lastSyncedAt: null,
    lastSyncError: '',
  };
}

// ── In-memory cache ────────────────────────────────────────────────────

let cached: AppState | null = null;

// Legacy plaintext vault password read out of `.app-state.json` on load, held
// as a "holdover" until `syncServiceE2ee.initSyncPassword()` confirms it into
// the OS keyring. `sanitize()` never keeps it in `cached`, so while this is
// set `saveAppState()` re-injects it on every write — otherwise any save that
// interleaves the keyring migration (theme change, sync timestamp, …) would
// scrub the field, and a subsequent keyring-write failure would leave the
// password in NEITHER place (K1). Cleared only by `clearLegacyE2eePassword()`,
// after the keyring write is confirmed, after which the next save scrubs it.
let legacyE2eePassword: string | undefined;

/** Peek at the legacy plaintext password captured during load (no clear). */
export function getLegacyE2eePassword(): string | undefined {
  return legacyE2eePassword;
}

/** Stop re-injecting the legacy password — call ONLY after the keyring write
 *  is confirmed, so the next `saveAppState()` scrubs it from disk. */
export function clearLegacyE2eePassword(): void {
  legacyE2eePassword = undefined;
}

// Legacy E2EE sync bookkeeping (`e2eeObjectMap` + `e2eeMaxVersion`) read out of a
// pre-port `.app-state.json` on load, held as a "holdover" until the Rust import
// consumes it into `.e2ee-state.json`. `sanitize()` drops these fields, so a
// naive save would erase the object map — and the boot keyring migration
// (`initSyncPassword`) performs exactly such a save BEFORE the user's first
// connect runs the Rust import. Erasing it strands the whole pre-port cohort on
// the empty-map reconcile path: unchanged notes survive only by hash-dedup and a
// note edited offline before the port is conflict-parked (PKT-17). While this is
// set, `saveAppState()` re-injects both fields on every write; the sync service
// clears it only once `.e2ee-state.json` exists (see
// `syncServiceE2ee.scrubLegacySyncStateIfConsumed`). `e2eeCollectionId` is NOT
// held here — it is a real `AppState` field that `sanitize()` already preserves.
let legacySyncState: { e2eeObjectMap: unknown; e2eeMaxVersion?: number } | undefined;

/** Peek at the legacy sync bookkeeping captured during load (no clear). */
export function getLegacySyncState():
  { e2eeObjectMap: unknown; e2eeMaxVersion?: number } | undefined {
  return legacySyncState;
}

/** Stop re-injecting the legacy sync bookkeeping — call ONLY once the Rust
 *  import has persisted `.e2ee-state.json`, so the next `saveAppState()` scrubs
 *  the now-dead fields from `.app-state.json`. */
export function clearLegacySyncState(): void {
  legacySyncState = undefined;
}

// ── Sanitization ───────────────────────────────────────────────────────

function sanitize(raw: unknown): AppState {
  const defaults = defaultState();
  if (!raw || typeof raw !== 'object') return defaults;
  const obj = raw as Record<string, unknown>;

  const deviceId =
    typeof obj.deviceId === 'string' && obj.deviceId.length > 0 ? obj.deviceId : defaults.deviceId;

  const rawPrefs = (
    obj.preferences && typeof obj.preferences === 'object' ? obj.preferences : {}
  ) as Record<string, unknown>;

  const rawCrash = (
    obj.crashReporting && typeof obj.crashReporting === 'object' ? obj.crashReporting : {}
  ) as Record<string, unknown>;

  const rawUpdates = (obj.updates && typeof obj.updates === 'object' ? obj.updates : {}) as Record<
    string,
    unknown
  >;

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
    updates: {
      enabled: typeof rawUpdates.enabled === 'boolean' ? rawUpdates.enabled : true,
    },
    lastSyncedAt: typeof obj.lastSyncedAt === 'number' ? obj.lastSyncedAt : null,
    lastSyncError: typeof obj.lastSyncError === 'string' ? obj.lastSyncError : '',
    // E2EE state — passthrough with type guards
    ...(typeof obj.e2eeServerUrl === 'string' ? { e2eeServerUrl: obj.e2eeServerUrl } : {}),
    ...(typeof obj.e2eeAuthToken === 'string' ? { e2eeAuthToken: obj.e2eeAuthToken } : {}),
    ...(typeof obj.e2eeUserId === 'string' ? { e2eeUserId: obj.e2eeUserId } : {}),
    ...(typeof obj.e2eeCollectionId === 'string' ? { e2eeCollectionId: obj.e2eeCollectionId } : {}),
    ...(typeof obj.e2eeSalt === 'string' ? { e2eeSalt: obj.e2eeSalt } : {}),
    // Only persist the deletion marker while it is actually outstanding (K3).
    ...(obj.pendingKeyringDeletion === true ? { pendingKeyringDeletion: true } : {}),
    // `e2eePassword` is intentionally NOT passed through — dropping it here
    // scrubs the legacy plaintext field on the next save (F6). The value is
    // captured for one-time keyring migration by `loadAppState` below.
    // `e2eeObjectMap` / `e2eeMaxVersion` from old builds: Rust migrates
    // them on first connect (see `sync_state::load_or_migrate`) and the
    // next saveAppState() drops them by not reading them back here.
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
        if (typeof prefs.sync.lastSyncedAt === 'number')
          state.lastSyncedAt = prefs.sync.lastSyncedAt;
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
      const parsed = JSON.parse(data);
      if (typeof parsed?.e2eePassword === 'string' && parsed.e2eePassword.length > 0) {
        legacyE2eePassword = parsed.e2eePassword;
      }
      // Capture the pre-port sync bookkeeping before `sanitize()` drops it, so
      // saves re-inject it until the Rust import consumes it (see the holdover
      // note above). A subsequent boot that still finds the fields (no
      // `.e2ee-state.json` yet) re-captures them — the migration self-heals
      // across restarts until one connect/sync persists.
      if (parsed?.e2eeObjectMap != null && typeof parsed.e2eeObjectMap === 'object') {
        legacySyncState = {
          e2eeObjectMap: parsed.e2eeObjectMap,
          ...(typeof parsed.e2eeMaxVersion === 'number'
            ? { e2eeMaxVersion: parsed.e2eeMaxVersion }
            : {}),
        };
      }
      cached = sanitize(parsed);
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

// Serialize the actual file writes so they COMPLETE in call order (R1). The
// payload is snapshotted synchronously at call time (below), but two writes
// whose I/O overlaps could otherwise finish out of order — e.g. an earlier
// save that captured the plaintext holdover finishing AFTER the migration's
// post-confirm scrub, restoring the plaintext as the final on-disk state.
let writeChain: Promise<void> = Promise.resolve();

export async function saveAppState(state: AppState): Promise<void> {
  cached = state;
  if (!hasFileSystem) return;
  const serialized: Record<string, unknown> = { ...state };
  // K1: while a legacy plaintext password is mid-migration to the keyring,
  // keep re-writing it to disk so an interleaved save can't strand the user
  // with the password in neither place. Confirmed migration calls
  // `clearLegacyE2eePassword()`, after which this stops and the field is
  // scrubbed on the next write. The holdover is read HERE (call time), so the
  // scrub's payload is fixed before it joins the write chain.
  if (legacyE2eePassword !== undefined) {
    serialized.e2eePassword = legacyE2eePassword;
  }
  // PKT-17: while a pre-port object map is awaiting the Rust import, re-inject
  // it on every write so an interleaved save (notably the boot keyring
  // migration's) can't erase it before the first connect imports it. Confirmed
  // consumption calls `clearLegacySyncState()`, after which this stops and
  // `sanitize()`'s drop takes effect on the next write. Read HERE (call time),
  // so the payload is fixed before it joins the write chain.
  if (legacySyncState !== undefined) {
    serialized.e2eeObjectMap = legacySyncState.e2eeObjectMap;
    if (legacySyncState.e2eeMaxVersion !== undefined) {
      serialized.e2eeMaxVersion = legacySyncState.e2eeMaxVersion;
    }
  }
  const payload = JSON.stringify(serialized);
  const run = writeChain.then(async () => {
    const fs = await getPlatformFS();
    await fs.writeAppData(APP_STATE_PATH, payload);
  });
  // Keep the chain alive even if this write rejects, so one failure doesn't
  // wedge every later save.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function updateAppState(
  updates: Partial<
    Pick<
      AppState,
      | 'lastSyncedAt'
      | 'lastSyncError'
      | 'preferences'
      | 'crashReporting'
      | 'updates'
      | 'e2eeServerUrl'
      | 'e2eeAuthToken'
      | 'e2eeUserId'
      | 'e2eeCollectionId'
      | 'e2eeSalt'
    >
  >,
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
  updates: {
    enabled: boolean;
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
    updates: { ...s.updates },
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
    updates: prefs.updates,
    lastSyncedAt: prefs.sync.lastSyncedAt,
    lastSyncError: prefs.sync.lastError,
  });
}

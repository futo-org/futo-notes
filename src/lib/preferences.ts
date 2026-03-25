import { getFS, hasFileSystem } from './platform';

const PREFS_PATH = '.preferences.json';
const PREFS_BACKUP_PATH = '.preferences.json.bak';

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

const DEFAULTS: AppPreferences = {
  appearance: {
    theme: 'auto',
  },
  crashReporting: {
    enabled: true,
    alwaysSend: false,
  },
  sync: {
    serverUrl: '',
    token: '',
    lastSyncedAt: null,
    lastError: '',
  },
};

let cached: AppPreferences | null = null;

function deepMerge(defaults: AppPreferences, saved: Partial<AppPreferences>): AppPreferences {
  return {
    appearance: {
      ...defaults.appearance,
      ...(saved.appearance ?? {}),
    },
    crashReporting: {
      ...defaults.crashReporting,
      ...(saved.crashReporting ?? {}),
    },
    sync: {
      ...defaults.sync,
      ...(saved.sync ?? {}),
    },
  };
}

export async function loadPreferences(): Promise<AppPreferences> {
  if (!hasFileSystem) {
    cached = {
      appearance: { ...DEFAULTS.appearance },
      crashReporting: { ...DEFAULTS.crashReporting },
      sync: { ...DEFAULTS.sync },
    };
    return cached;
  }

  // Try main preferences file
  try {
    const data = await getFS().readAppData(PREFS_PATH);
    if (data) {
      const saved = JSON.parse(data);
      cached = deepMerge(DEFAULTS, saved);
      return cached;
    }
  } catch {
    // Main file corrupt or unreadable — try backup
    try {
      const backupData = await getFS().readAppData(PREFS_BACKUP_PATH);
      if (backupData) {
        const saved = JSON.parse(backupData);
        cached = deepMerge(DEFAULTS, saved);
        console.warn('Preferences recovery: loaded from backup after corrupt main preferences file');
        return cached;
      }
    } catch {
      // Backup also failed
    }
    console.warn('Preferences recovery: using defaults after corrupt/missing preferences file');
  }

  cached = {
    appearance: { ...DEFAULTS.appearance },
    crashReporting: { ...DEFAULTS.crashReporting },
    sync: { ...DEFAULTS.sync },
  };
  return cached;
}

export function getCachedPreferences(): AppPreferences {
  if (cached) return cached;
  return {
    appearance: { ...DEFAULTS.appearance },
    crashReporting: { ...DEFAULTS.crashReporting },
    sync: { ...DEFAULTS.sync },
  };
}

export async function savePreferences(prefs: AppPreferences): Promise<void> {
  cached = prefs;
  if (!hasFileSystem) return;

  // Back up current preferences before writing new ones
  try {
    const current = await getFS().readAppData(PREFS_PATH);
    if (current) {
      await getFS().writeAppData(PREFS_BACKUP_PATH, current);
    }
  } catch {
    // No existing prefs to back up — that's fine
  }

  await getFS().writeAppData(PREFS_PATH, JSON.stringify(prefs, null, 2));
}

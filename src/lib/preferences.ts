import { getFS, hasFileSystem } from './platform';

const PREFS_PATH = '.preferences.json';

export interface AppPreferences {
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
      crashReporting: { ...DEFAULTS.crashReporting },
      sync: { ...DEFAULTS.sync },
    };
    return cached;
  }

  try {
    const data = await getFS().readAppData(PREFS_PATH);
    if (data) {
      const saved = JSON.parse(data);
      cached = deepMerge(DEFAULTS, saved);
    } else {
      cached = {
        crashReporting: { ...DEFAULTS.crashReporting },
        sync: { ...DEFAULTS.sync },
      };
    }
  } catch {
    cached = {
      crashReporting: { ...DEFAULTS.crashReporting },
      sync: { ...DEFAULTS.sync },
    };
  }
  return cached;
}

export function getCachedPreferences(): AppPreferences {
  if (cached) return cached;
  return {
    crashReporting: { ...DEFAULTS.crashReporting },
    sync: { ...DEFAULTS.sync },
  };
}

export async function savePreferences(prefs: AppPreferences): Promise<void> {
  cached = prefs;
  if (!hasFileSystem) return;

  await getFS().writeAppData(PREFS_PATH, JSON.stringify(prefs, null, 2));
}

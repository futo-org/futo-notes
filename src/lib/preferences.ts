import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';

const PREFS_PATH = 'futo-notes/.preferences.json';

export interface AppPreferences {
  crashReporting: {
    enabled: boolean;
    alwaysSend: boolean;
  };
}

const DEFAULTS: AppPreferences = {
  crashReporting: {
    enabled: true,
    alwaysSend: false,
  },
};

let cached: AppPreferences | null = null;

function deepMerge(defaults: AppPreferences, saved: Partial<AppPreferences>): AppPreferences {
  return {
    crashReporting: {
      ...defaults.crashReporting,
      ...(saved.crashReporting ?? {}),
    },
  };
}

export async function loadPreferences(): Promise<AppPreferences> {
  if (!Capacitor.isNativePlatform()) {
    cached = { crashReporting: { ...DEFAULTS.crashReporting } };
    return cached;
  }

  try {
    const result = await Filesystem.readFile({
      path: PREFS_PATH,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    });
    const saved = JSON.parse(result.data as string);
    cached = deepMerge(DEFAULTS, saved);
  } catch {
    cached = { crashReporting: { ...DEFAULTS.crashReporting } };
  }
  return cached;
}

export function getCachedPreferences(): AppPreferences {
  if (cached) return cached;
  return { crashReporting: { ...DEFAULTS.crashReporting } };
}

export async function savePreferences(prefs: AppPreferences): Promise<void> {
  cached = prefs;
  if (!Capacitor.isNativePlatform()) return;

  await Filesystem.writeFile({
    path: PREFS_PATH,
    data: JSON.stringify(prefs, null, 2),
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
  });
}

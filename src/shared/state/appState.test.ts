// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform');

async function fresh() {
  vi.resetModules();
  return await import('./appState');
}

beforeEach(async () => {
  const platform = await import('$lib/platform');
  platform.resetActiveFS();
  platform.testFS._reset();
});

describe('updates preference', () => {
  it('defaults to enabled', async () => {
    const { getCachedPreferences } = await fresh();
    expect(getCachedPreferences().updates.enabled).toBe(true);
  });

  it('round-trips a disable through savePreferences', async () => {
    const { getCachedPreferences, savePreferences } = await fresh();
    const p = getCachedPreferences();
    p.updates.enabled = false;
    await savePreferences(p);
    expect(getCachedPreferences().updates.enabled).toBe(false);
  });
});

describe('language preference', () => {
  it('defaults to System', async () => {
    const { getCachedPreferences } = await fresh();
    expect(getCachedPreferences().language.selectedLanguageTag).toBeNull();
  });

  it('persists a selected language across a reload', async () => {
    const firstLaunch = await fresh();
    await firstLaunch.loadAppState();
    await firstLaunch.saveSelectedLanguageTag('zh-Hans');

    const secondLaunch = await fresh();
    await secondLaunch.loadAppState();

    expect(secondLaunch.getCachedPreferences().language.selectedLanguageTag).toBe('zh-Hans');
  });

  it('preserves hydrated state when language changes during startup', async () => {
    const platform = await import('$lib/platform');
    await platform.testFS.writeAppData(
      '.app-state.json',
      JSON.stringify({
        deviceId: 'persisted-device',
        preferences: { theme: 'dark', selectedLanguageTag: null },
        crashReporting: { enabled: false, alwaysSend: false },
        updates: { enabled: false },
        lastSyncedAt: 123,
        lastSyncError: 'kept',
        e2eeServerUrl: 'https://sync.example',
        e2eeAuthToken: 'persisted-token',
      }),
    );

    let signalFirstReadStarted = () => {};
    const firstReadStarted = new Promise<void>((resolve) => {
      signalFirstReadStarted = resolve;
    });
    let releaseFirstRead = () => {};
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let isFirstRead = true;
    const gatedFileSystem: typeof platform.testFS = {
      ...platform.testFS,
      async readAppData(relativePath) {
        const snapshot = await platform.testFS.readAppData(relativePath);
        if (isFirstRead) {
          isFirstRead = false;
          signalFirstReadStarted();
          await firstReadGate;
        }
        return snapshot;
      },
    };
    platform.setActiveFS(gatedFileSystem);

    try {
      const appState = await fresh();
      const startupLoad = appState.loadAppState();
      await firstReadStarted;
      const languageSave = appState.saveSelectedLanguageTag('zh-Hans');
      releaseFirstRead();
      await Promise.all([startupLoad, languageSave]);

      const persisted = JSON.parse(
        (await platform.testFS.readAppData('.app-state.json')) ?? 'null',
      );
      expect(persisted).toMatchObject({
        deviceId: 'persisted-device',
        preferences: { theme: 'dark', selectedLanguageTag: 'zh-Hans' },
        crashReporting: { enabled: false, alwaysSend: false },
        updates: { enabled: false },
        lastSyncedAt: 123,
        lastSyncError: 'kept',
        e2eeServerUrl: 'https://sync.example',
        e2eeAuthToken: 'persisted-token',
      });
      expect(appState.getCachedPreferences().language.selectedLanguageTag).toBe('zh-Hans');
    } finally {
      platform.resetActiveFS();
    }
  });
});

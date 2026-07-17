// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  applyThemePreference: vi.fn(() => new Promise<void>(() => undefined)),
  getPlatformFS: vi.fn(() => new Promise(() => undefined)),
  initNotes: vi.fn(() => new Promise<void>(() => undefined)),
  initSyncPassword: vi.fn(() => new Promise<void>(() => undefined)),
  loadPreferences: vi.fn(() => new Promise(() => undefined)),
  stopUpdates: vi.fn(),
  startUpdates: vi.fn(() => new Promise<void>(() => undefined)),
  watchSystemThemeTauri: vi.fn(() => vi.fn()),
}));

vi.mock('$features/system/updateChecker.svelte', () => ({
  updateChecker: { start: dependencies.startUpdates, stop: dependencies.stopUpdates },
}));
vi.mock('$features/sync/syncServiceE2ee', () => ({
  initSyncPassword: dependencies.initSyncPassword,
}));
vi.mock('$shared/state/appState', () => ({
  getCachedPreferences: () => ({ appearance: { theme: 'auto' } }),
  loadPreferences: dependencies.loadPreferences,
}));
vi.mock('$features/notes/notes.svelte', () => ({ initNotes: dependencies.initNotes }));
vi.mock('$lib/platform', () => ({
  getPlatformFS: dependencies.getPlatformFS,
  hasFileSystem: true,
}));
vi.mock('$features/system/theme', () => ({
  applyThemePreference: dependencies.applyThemePreference,
  watchSystemThemeTauri: dependencies.watchSystemThemeTauri,
}));

import { createAppBootstrap } from './createAppBootstrap.svelte';

describe('application first-render contract', () => {
  it('marks the shell initialized before any background I/O resolves', () => {
    const bootstrap = createAppBootstrap({
      initializeCrashReporting: () => new Promise<void>(() => undefined),
      installDevelopmentHooks: vi.fn(),
    });

    const stop = bootstrap.start();

    expect(bootstrap.initialized).toBe(true);
    expect(dependencies.getPlatformFS).toHaveBeenCalledOnce();
    expect(dependencies.loadPreferences).toHaveBeenCalledOnce();
    expect(dependencies.initNotes).toHaveBeenCalledOnce();
    expect(dependencies.initSyncPassword).toHaveBeenCalledOnce();
    expect(dependencies.startUpdates).toHaveBeenCalledOnce();

    stop();
    expect(dependencies.stopUpdates).toHaveBeenCalledOnce();
  });
});

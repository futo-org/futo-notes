// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// M1 render gate: every dependency hangs forever so the test proves the shell
// gate cannot be waiting on any of them. (Factories are hoisted, so the
// never-resolving promise is inlined per mock.)
vi.mock('$features/system/updateChecker.svelte', () => ({
  updateChecker: { start: vi.fn(() => new Promise(() => {})), stop: vi.fn() },
}));
vi.mock('$features/sync/syncServiceE2ee', () => ({
  initSyncPassword: vi.fn(() => new Promise(() => {})),
}));
vi.mock('$shared/state/appState', () => ({
  loadPreferences: vi.fn(() => new Promise(() => {})),
  getCachedPreferences: vi.fn(() => ({ appearance: { theme: 'auto' } })),
}));
vi.mock('$features/notes/notes.svelte', () => ({
  initNotes: vi.fn(() => new Promise(() => {})),
}));
vi.mock('$lib/platform', () => ({
  getPlatformFS: vi.fn(() => new Promise(() => {})),
  hasFileSystem: true,
}));
vi.mock('$features/system/theme', () => ({
  applyThemePreference: vi.fn(() => new Promise(() => {})),
  watchSystemThemeTauri: vi.fn(() => () => {}),
}));

import { createAppBootstrap } from './createAppBootstrap.svelte';

const never = () => new Promise<never>(() => {});

describe('createAppBootstrap (M1 render gate)', () => {
  it('flips initialized synchronously even when every init call never resolves', () => {
    const bootstrap = createAppBootstrap({
      initializeCrashReporting: vi.fn(never),
      installDevelopmentHooks: vi.fn(),
    });

    expect(bootstrap.initialized).toBe(false);
    const stop = bootstrap.start();
    // Asserted synchronously — no awaits, no timers. If start() ever awaits
    // filesystem/preference/platform I/O before flipping the gate, this reads
    // false and the shell would render nothing until that I/O completed (M1).
    expect(bootstrap.initialized).toBe(true);
    stop();
  });

  it('keeps the render gate up when an init step rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bootstrap = createAppBootstrap({
      initializeCrashReporting: vi.fn(() => Promise.reject(new Error('collector down'))),
      installDevelopmentHooks: vi.fn(),
    });

    const stop = bootstrap.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(bootstrap.initialized).toBe(true);
    stop();
    warn.mockRestore();
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriFS = vi.hoisted(() => ({}));

vi.mock('./tauri', () => ({ tauriFS }));

beforeEach(() => {
  vi.resetModules();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('platform facade contract', () => {
  it('keeps synchronous access gated only until the lazy Tauri adapter resolves', async () => {
    Reflect.set(window, '__TAURI_INTERNALS__', {});
    const platform = await import('./index');

    expect(platform.platformName).toBe('tauri');
    expect(() => platform.getFS()).toThrow('Platform FS not initialized');

    await expect(platform.getPlatformFS()).resolves.toBe(tauriFS);
    await expect(platform.getPlatformFS()).resolves.toBe(tauriFS);
    expect(platform.getFS()).toBe(tauriFS);
  });
});

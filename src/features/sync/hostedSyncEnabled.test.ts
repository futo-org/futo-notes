// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ isTauri: true }));
vi.mock('$lib/platform', () => platform);

beforeEach(() => {
  vi.resetModules();
  platform.isTauri = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function enabled(): Promise<boolean> {
  const { hostedSyncEnabled } = await import('./hostedSyncEnabled');
  return hostedSyncEnabled();
}

describe('hostedSyncEnabled', () => {
  it('is on for a debug build', async () => {
    vi.stubEnv('DEV', true);
    await expect(enabled()).resolves.toBe(true);
  });

  it('is off for a release build that did not opt in', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_HOSTED_SYNC', undefined);
    await expect(enabled()).resolves.toBe(false);
  });

  it('is on for a release build that opted in', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_HOSTED_SYNC', 'true');
    await expect(enabled()).resolves.toBe(true);
  });

  it('only counts an exact opt-in, so a stray value cannot ship the flow', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_HOSTED_SYNC', '1');
    await expect(enabled()).resolves.toBe(false);
  });

  it('is off off Tauri, where none of the commands behind it exist', async () => {
    platform.isTauri = false;
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_HOSTED_SYNC', 'true');
    await expect(enabled()).resolves.toBe(false);
  });
});

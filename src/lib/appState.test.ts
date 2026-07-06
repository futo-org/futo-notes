// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

/** Re-import so each test gets a fresh module-level cache. */
async function fresh() {
  vi.resetModules();
  return await import('./appState');
}

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

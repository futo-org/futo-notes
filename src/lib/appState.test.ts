import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform');

import { createNodeFS, setActiveFS, resetActiveFS } from '$lib/platform';

async function freshAppState() {
  vi.resetModules();
  return await import('./appState');
}

describe('appState baseContent migration', () => {
  beforeEach(() => {
    resetActiveFS();
  });

  it('strips baseContent from every object-map entry on load', async () => {
    const fs = createNodeFS();
    setActiveFS(fs);

    const legacy = {
      deviceId: 'dev-1',
      preferences: { theme: 'auto', sortOrder: 'modified' },
      crashReporting: { enabled: true, alwaysSend: false },
      lastSyncedAt: 123,
      lastSyncError: '',
      e2eeObjectMap: {
        'note-a.md': {
          objectId: 'o-a',
          version: 3,
          blobKey: 'u/bk-a',
          hash: 'h-a',
          baseContent: 'this was the plaintext body we used to store',
          mtimeMs: 10,
          sizeBytes: 20,
        },
        'note-b.md': {
          objectId: 'o-b',
          version: 1,
          blobKey: 'u/bk-b',
          baseContent: 'another body',
        },
      },
    };
    await fs.writeAppData('.app-state.json', JSON.stringify(legacy));

    const appState = await freshAppState();
    const loaded = await appState.loadAppState();

    expect(loaded.e2eeObjectMap).toBeDefined();
    const mapA = loaded.e2eeObjectMap!['note-a.md'] as Record<string, unknown>;
    const mapB = loaded.e2eeObjectMap!['note-b.md'] as Record<string, unknown>;

    expect(mapA).toEqual({
      objectId: 'o-a',
      version: 3,
      blobKey: 'u/bk-a',
      hash: 'h-a',
      mtimeMs: 10,
      sizeBytes: 20,
    });
    expect('baseContent' in mapA).toBe(false);

    expect(mapB).toEqual({
      objectId: 'o-b',
      version: 1,
      blobKey: 'u/bk-b',
    });
    expect('baseContent' in mapB).toBe(false);
  });

  it('drops map entries that are missing required fields', async () => {
    const fs = createNodeFS();
    setActiveFS(fs);

    await fs.writeAppData(
      '.app-state.json',
      JSON.stringify({
        e2eeObjectMap: {
          'valid.md': { objectId: 'o', version: 1, blobKey: 'k' },
          'no-blob.md': { objectId: 'o', version: 1 },
          'no-version.md': { objectId: 'o', blobKey: 'k' },
        },
      }),
    );

    const appState = await freshAppState();
    const loaded = await appState.loadAppState();
    expect(Object.keys(loaded.e2eeObjectMap!)).toEqual(['valid.md']);
  });
});

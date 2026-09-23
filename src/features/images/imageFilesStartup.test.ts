import { describe, expect, it, vi } from 'vitest';

// The sidebar reopens on whichever tab was last used, so the images tab can
// mount before app bootstrap has resolved the platform. With the synchronous
// accessor that threw, and the tab showed "No images" until you switched tabs
// and back.
const vaultFiles = [{ name: 'trip/beach.png', size: 10, mtime: 5 }];

vi.mock('$lib/platform', () => ({
  getFS: () => {
    throw new Error('Platform FS not initialized — call getPlatformFS() first');
  },
  getPlatformFS: async () => ({
    listVaultFiles: async (include: (path: string) => boolean) =>
      vaultFiles.filter((f) => include(f.name)),
  }),
}));

describe('listImageFiles before the platform is ready', () => {
  it('waits for the platform instead of reporting an empty vault', async () => {
    const { listImageFiles } = await import('./imageFiles');

    expect(await listImageFiles()).toEqual([{ filename: 'trip/beach.png', size: 10, mtime: 5 }]);
  });
});

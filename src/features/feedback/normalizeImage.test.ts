import { describe, expect, it } from 'vitest';

import { MAX_IMAGE_BYTES, needsTranscode } from './normalizeImage';

describe('needsTranscode', () => {
  it('passes through the formats the server accepts, whatever case the picker reports', () => {
    for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'PNG', 'JPEG']) {
      expect(needsTranscode(extension, 1024)).toBe(false);
    }
  });

  it('transcodes formats the dashboard cannot render', () => {
    for (const extension of ['heic', 'gif', 'avif', 'bmp', 'svg', 'tiff']) {
      expect(needsTranscode(extension, 1024)).toBe(true);
    }
  });

  it('transcodes an accepted format only once it is over the size cap', () => {
    expect(needsTranscode('png', MAX_IMAGE_BYTES)).toBe(false);
    expect(needsTranscode('png', MAX_IMAGE_BYTES + 1)).toBe(true);
  });
});

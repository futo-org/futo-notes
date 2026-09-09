import { describe, expect, it } from 'vitest';

import { MAX_IMAGE_BYTES, needsTranscode } from './normalizeImage';

describe('needsTranscode', () => {
  it('passes through the formats the server accepts', () => {
    for (const extension of ['png', 'jpg', 'jpeg', 'webp']) {
      expect(needsTranscode(extension, 1024)).toBe(false);
    }
  });

  it('ignores the case the picker reports', () => {
    expect(needsTranscode('PNG', 1024)).toBe(false);
    expect(needsTranscode('JPEG', 1024)).toBe(false);
  });

  it('transcodes formats the dashboard cannot render', () => {
    for (const extension of ['heic', 'gif', 'avif', 'bmp', 'svg', 'tiff']) {
      expect(needsTranscode(extension, 1024)).toBe(true);
    }
  });

  it('transcodes an accepted format that is over the size cap', () => {
    expect(needsTranscode('png', MAX_IMAGE_BYTES + 1)).toBe(true);
  });

  it('leaves an accepted format exactly at the cap alone', () => {
    expect(needsTranscode('png', MAX_IMAGE_BYTES)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { imageReferenceMarkdown } from './images';

describe('imageReferenceMarkdown', () => {
  it('writes a linkless image reference with a trailing newline', () => {
    expect(imageReferenceMarkdown('image-1712.png')).toBe('![](image-1712.png)\n');
  });

  it('leaves a filename with spaces exactly as the vault stores it', () => {
    expect(imageReferenceMarkdown('my photo.png')).toBe('![](my photo.png)\n');
  });
});

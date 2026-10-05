import { describe, expect, it } from 'vitest';

import { defaultImageTitles } from './imageTitle';
import type { MdastNode } from './mdast';

describe('defaultImageTitles', () => {
  it('turns the null title of a title-less image into an empty string', () => {
    const image: MdastNode = { type: 'image', url: 'pic.png', title: null };
    defaultImageTitles({ type: 'root', children: [{ type: 'paragraph', children: [image] }] });
    expect(image.title).toBe('');
  });

  it('gives an image whose title is absent the same empty string', () => {
    const image: MdastNode = { type: 'image', url: 'pic.png' };
    defaultImageTitles({ type: 'root', children: [image] });
    expect(image.title).toBe('');
  });

  it('keeps a real title', () => {
    const image: MdastNode = { type: 'image', url: 'pic.png', title: 'caption' };
    defaultImageTitles({ type: 'root', children: [image] });
    expect(image.title).toBe('caption');
  });

  it('leaves links, whose title attr accepts null, alone', () => {
    const link: MdastNode = { type: 'link', url: 'x.md', title: null, children: [] };
    defaultImageTitles({ type: 'root', children: [link] });
    expect(link.title).toBeNull();
  });
});

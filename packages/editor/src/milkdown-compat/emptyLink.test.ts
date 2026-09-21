import { describe, expect, it } from 'vitest';

import { expandEmptyLinks } from './emptyLink';
import type { MdastNode } from './mdast';

describe('expandEmptyLinks', () => {
  it('gives an empty-label link its URL as visible text', () => {
    // "[](api-plan.md)" — mdast gives an empty-label link zero children, and
    // Milkdown's link mark has nothing to attach to, so the href vanishes too.
    const link: MdastNode = { type: 'link', url: 'api-plan.md', children: [] };
    expandEmptyLinks({ type: 'root', children: [link] });
    expect(link.children).toEqual([{ type: 'text', value: 'api-plan.md' }]);
  });

  it('leaves a link that already has text alone', () => {
    const link: MdastNode = {
      type: 'link',
      url: 'api-plan.md',
      children: [{ type: 'text', value: 'the plan' }],
    };
    expandEmptyLinks({ type: 'root', children: [link] });
    expect(link.children).toEqual([{ type: 'text', value: 'the plan' }]);
  });

  it('leaves an image with empty alt text alone', () => {
    // "![](pic.png)" is a decorative image, already lossless. The regex version
    // of this fix rewrote every one of these and had to be caught by a re-run.
    const image: MdastNode = { type: 'image', url: 'pic.png', children: [] };
    expandEmptyLinks({ type: 'root', children: [image] });
    expect(image.children).toEqual([]);
  });

  it('leaves a link with no URL alone', () => {
    const link: MdastNode = { type: 'link', url: '', children: [] };
    expandEmptyLinks({ type: 'root', children: [link] });
    expect(link.children).toEqual([]);
  });

  it('reaches links nested inside other content', () => {
    const link: MdastNode = { type: 'link', url: 'x.md', children: [] };
    expandEmptyLinks({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'emphasis', children: [link] }] }],
    });
    expect(link.children).toEqual([{ type: 'text', value: 'x.md' }]);
  });
});

import { $remark } from '@milkdown/kit/utils';

import type { MdastNode } from './mdast';
import { walk } from './mdast';

/**
 * Give a title-less image the empty-string title its schema attr expects.
 *
 * `@milkdown/preset-commonmark@7.22.1`'s `imageSchema` declares
 * `title: { default: '', validate: 'string' }` but its parser copies mdast's
 * `image.title` straight across, and mdast gives `![alt](src)` `title: null`.
 * The node is built with `title: null`, which its own validator rejects: any
 * `doc.check()` or `schema.nodeFromJSON(doc.toJSON())` over an ordinary note
 * with an image throws `Expected value of type string for attribute title on
 * type image, got null` (157 of 2,000 fuzz documents).
 *
 * An empty title and no title are the same thing on the way back out —
 * mdast-util-to-markdown writes a title only when it is truthy — so this is
 * lossless; `![a](b.png "t")` keeps its title.
 */
export function defaultImageTitles(tree: MdastNode): void {
  walk(tree, (node) => {
    if (node.type === 'image' && node.title == null) node.title = '';
  });
}

export const remarkImageTitlePlugin = $remark('futo-image-title', () => () => defaultImageTitles);

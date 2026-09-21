import { $remark } from '@milkdown/kit/utils';

import type { MdastNode } from './mdast';
import { walk } from './mdast';

/**
 * Give empty-label links their URL as visible text.
 *
 * `@milkdown/preset-commonmark@7.22.1`'s `mark/link.ts` parses a `link` mdast
 * node with `state.next(node.children)`. mdast gives `[](url)` zero children,
 * so that call adds nothing — and because Milkdown models a link as a *mark*,
 * which needs text to attach to, the href disappears with it. `[](api-plan.md)`
 * round-trips to nothing at all. The census found this in the wild (idx 7687).
 *
 * The repair is one-way and deliberate: `[](url)` becomes `[url](url)`, the
 * same category as Milkdown's other forward-only normalizations. There is no
 * restore pass, because an invisible link label is not content worth preserving
 * — the href is.
 *
 * Images are a different mdast node type (`image`, whose empty label is *alt
 * text*, a legitimate and lossless shape), so they cannot be caught here. The
 * regex version of this fix could, and rewrote every `![](pic.png)`'s alt text
 * to the URL before that was caught.
 */
export function expandEmptyLinks(tree: MdastNode): void {
  walk(tree, (node) => {
    if (node.type !== 'link') return;
    if (node.children && node.children.length > 0) return;
    const url = node.url;
    if (!url) return;
    node.children = [{ type: 'text', value: url }];
  });
}

export const remarkExpandEmptyLinksPlugin = $remark(
  'futo-expand-empty-links',
  () => () => expandEmptyLinks,
);

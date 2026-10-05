import { $remark } from '@milkdown/kit/utils';

import type { MdastNode } from './mdast';
import { walk } from './mdast';

const MARKER = /^\[( |x|X)\]$/;

/**
 * Read a list item whose first paragraph is only `[ ]` / `[x]` as an EMPTY task item.
 *
 * GFM's task-list extension needs something after the marker, so `- [ ]` on its
 * own parses as a bullet whose paragraph is the literal text `[ ]`. That made an
 * empty task item — what the toolbar's Task button, or Enter after a task,
 * leaves the caret in — impossible to save: it went to disk as a bare `-` and
 * reopened as a plain bullet (iOS 27 lane, `O1/O10`). The serializer now writes
 * `- [ ]` for it (`./listItemFiller`), and this is the other half: the same bytes
 * read back as the empty task item they came from.
 *
 * An item whose text really is a literal `[ ]` becomes an empty task item too;
 * that is what such a line means to every markdown reader that supports task
 * lists. The user's explicit escape, `\[ \]`, is NOT that: it resolves to the
 * same text but spans five source characters, and stays the literal text they
 * wrote.
 */
export function markEmptyTaskItems(tree: MdastNode): void {
  walk(tree, (node) => {
    if (node.type !== 'listItem' || node.checked != null) return;
    // Only the FIRST child: `- [ ]` followed by an indented nested list is an
    // empty task item that has children, and is written that way.
    const only = node.children?.[0];
    if (!only || only.type !== 'paragraph') return;
    const [text, ...more] = only.children ?? [];
    if (!text || more.length > 0 || text.type !== 'text') return;
    const marker = MARKER.exec(text.value ?? '');
    if (!marker) return;
    // The parser resolves escapes, so `\[ \]` yields the same text value as a
    // literal `[ ]`. Only the source span tells them apart: a literal marker
    // is exactly three characters wide. A hand-built node with no offsets
    // (no source to consult) keeps the value-only reading.
    const start = text.position?.start.offset;
    const end = text.position?.end.offset;
    if (start != null && end != null && end - start !== 3) return;
    node.checked = marker[1] !== ' ';
    only.children = [];
  });
}

export const remarkEmptyTaskItemPlugin = $remark(
  'futo-empty-task-item',
  () => () => markEmptyTaskItems,
);

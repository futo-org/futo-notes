/*
 * Ordered-list numbering that only looks at what changed.
 *
 * Milkdown's own `syncListOrderPlugin` (preset-commonmark) keeps every list
 * item's `label` attribute ("1.", "2.", …) and `listType` in step with its
 * position, and turns a bullet list whose first item is ordered into an ordered
 * list. It does that by walking the WHOLE document on every generic
 * transaction, which on the low-end Android reference phone measured 18ms per
 * keystroke at 10k lines by itself (tests/android-editor-perf-quick.mjs
 * --profile, 2026-09-04) against a 16ms budget for the entire keystroke.
 *
 * A list item's label depends only on its own list, so the same rules are
 * applied here to just the top-level blocks the transaction touched. The
 * per-item logic is Milkdown's, verbatim; only the traversal is narrowed.
 */
import {
  bulletListSchema,
  listItemSchema,
  orderedListSchema,
} from '@milkdown/kit/preset/commonmark';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';
import { nodesInTouchedRange, touchedTopLevelRange } from './touchedRange';

export const scopedListOrderPlugin = $prose((ctx) => {
  const syncOrderLabel = (
    transactions: readonly Transaction[],
    _oldState: { doc: ProseNode },
    newState: { doc: ProseNode; selection: unknown; tr: Transaction },
  ): Transaction | null => {
    if (
      !newState.selection ||
      transactions.some((tr) => tr.getMeta('addToHistory') === false || !tr.isGeneric)
    ) {
      return null;
    }
    const range = touchedTopLevelRange(transactions, newState.doc);
    if (!range) return null;

    const orderedListType = orderedListSchema.type(ctx);
    const bulletListType = bulletListSchema.type(ctx);
    const listItemType = listItemSchema.type(ctx);
    const handleNodeItem = (attrs: Record<string, unknown>, index: number, order = 1) => {
      const expectedLabel = `${index + order}.`;
      if (attrs.label === expectedLabel) return false;
      attrs.label = expectedLabel;
      return true;
    };

    let tr = newState.tr;
    let needDispatch = false;
    nodesInTouchedRange(newState.doc, range, (node, pos, parent, index) => {
      if (node.type === bulletListType) {
        const base = node.maybeChild(0);
        if (base?.type === listItemType && base.attrs.listType === 'ordered') {
          needDispatch = true;
          tr.setNodeMarkup(pos, orderedListType, { spread: true });
          node.descendants((child, childPos, _parent, childIndex) => {
            if (child.type === listItemType) {
              const attrs = { ...child.attrs };
              if (handleNodeItem(attrs, childIndex))
                tr = tr.setNodeMarkup(childPos, undefined, attrs);
            }
            return false;
          });
        }
      } else if (node.type === listItemType && parent?.type === orderedListType) {
        const attrs = { ...node.attrs };
        let changed = false;
        if (attrs.listType !== 'ordered') {
          attrs.listType = 'ordered';
          changed = true;
        }
        if (parent.maybeChild(0)) {
          changed = handleNodeItem(attrs, index, (parent.attrs.order as number | undefined) ?? 1);
        }
        if (changed) {
          tr = tr.setNodeMarkup(pos, undefined, attrs);
          needDispatch = true;
        }
      }
    });
    return needDispatch ? tr.setMeta('addToHistory', false) : null;
  };

  return new Plugin({
    key: new PluginKey('FUTO_SCOPED_LIST_ORDER'),
    appendTransaction: syncOrderLabel,
  });
});

/*
 * A test-only re-implementation of `@milkdown/preset-commonmark`'s
 * `syncListOrderPlugin` (node_modules/@milkdown/preset-commonmark/src/plugin/
 * sync-list-order-plugin.ts), against `testSchema` instead of the real
 * preset's internal node registrations.
 *
 * Why this exists: `blockCommands.ts`'s own test helpers run every command
 * against a PLUGIN-FREE `EditorState` (`scratchState`), which is deliberate —
 * see that file's comment — but it also means a bug that only shows up once
 * the real preset's `appendTransaction` runs is invisible to those tests. QA
 * #002 (toggling a list back does nothing) was exactly that: `retargetList`
 * only rewrote the `listType` attr of the items the selection touched, and
 * this plugin's own self-healing logic reverted the untouched direction. A
 * test that wants to prove the toggle survives the real editor has to install
 * an equivalent of this plugin, which is what this fixture is for.
 *
 * Reproduces only the TWO branches that drive the self-healing behavior QA
 * hit (both read off the OUTER, correctly-absolute-positioned traversal of
 * `newState.doc.descendants`):
 *   - a `bullet_list` whose first item's `listType` attr already reads
 *     `"ordered"` gets promoted to `ordered_list` wholesale;
 *   - any `list_item` directly under an `ordered_list` gets its `listType`
 *     forced to `"ordered"` if it does not already say so.
 * Deliberately DOES NOT port the upstream plugin's nested per-item numeric
 * `label` relabeling pass: that pass calls `.descendants()` on the list
 * sub-node directly, whose reported positions are relative to that node's own
 * content start rather than the document root, and is cosmetic (the "1." /
 * "2." numbering text) rather than the `listType` attribute this bug is
 * about — carrying it over here would add a second, unrelated correctness
 * question to a fixture that only needs to prove the `listType` self-heal.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, type EditorState, type Transaction } from '@milkdown/kit/prose/state';

export function syncListOrderPluginFixture(): Plugin {
  return new Plugin({
    appendTransaction(
      transactions: readonly Transaction[],
      _oldState: EditorState,
      newState: EditorState,
    ) {
      const {
        bullet_list: bulletListType,
        ordered_list: orderedListType,
        list_item: listItemType,
      } = newState.schema.nodes;
      if (!bulletListType || !orderedListType || !listItemType) return null;
      if (transactions.some((tr) => tr.getMeta('addToHistory') === false)) return null;

      let tr = newState.tr;
      let needDispatch = false;

      newState.doc.descendants((node: ProseNode, pos: number, parent: ProseNode | null) => {
        if (node.type === bulletListType) {
          const base = node.maybeChild(0);
          if (base?.type === listItemType && base.attrs.listType === 'ordered') {
            needDispatch = true;
            tr = tr.setNodeMarkup(pos, orderedListType, { spread: node.attrs.spread ?? false });
          }
        } else if (node.type === listItemType && parent?.type === orderedListType) {
          if (node.attrs.listType !== 'ordered') {
            tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, listType: 'ordered' });
            needDispatch = true;
          }
        }
        return true;
      });

      return needDispatch ? tr.setMeta('addToHistory', false) : null;
    },
  });
}

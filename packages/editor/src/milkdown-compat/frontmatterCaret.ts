/**
 * Where the caret goes around the front matter block.
 *
 * The block ({@link ./frontmatter}) is an unselectable, `contenteditable="false"`
 * atom at the very top of the document, so it has no caret position of its own:
 * the plugins here land the caret at the top of the BODY instead. Like the rest
 * of this directory, these are adapters to one editor library, with no Rust
 * mirror.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin as ProsePlugin, Selection } from '@milkdown/kit/prose/state';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { FRONTMATTER_NODE } from './frontmatter';

/**
 * A tap or click on the block puts the caret at the top of the BODY.
 *
 * Without this the block is a dead spot that still looks live: it is
 * `contenteditable="false"` and unselectable, so a tap focuses the editor and
 * raises the keyboard and then the first character goes nowhere. Measured on
 * the iOS simulator — tapping the panel and typing `X` left the file untouched,
 * while the same tap on the body wrote it — and the panel sits at the very top
 * of the note, which is exactly where a reader taps first.
 *
 * Placing the caret after the node is also the only answer that cannot lose
 * anything: there is no position INSIDE an atom, and putting a selection ON it
 * is the thing `selectable: false` exists to prevent.
 */
const frontmatterClickPlugin = $prose(
  () =>
    new ProsePlugin({
      props: {
        handleClickOn: (
          view: ProseView,
          _pos: number,
          node: ProseNode,
          nodePos: number,
        ): boolean => {
          if (node.type.name !== FRONTMATTER_NODE) return false;
          const after = Selection.near(view.state.doc.resolve(nodePos + node.nodeSize), 1);
          view.dispatch(view.state.tr.setSelection(after).scrollIntoView());
          return true;
        },
      },
    }),
);

/** The caret plugins, registered after {@link ./frontmatter}'s `frontmatterPlugins`. */
export const frontmatterCaretPlugins = [frontmatterClickPlugin];

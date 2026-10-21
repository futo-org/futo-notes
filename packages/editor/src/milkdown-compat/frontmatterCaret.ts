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
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
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

/**
 * The first caret position in the BODY of a document that opens with front
 * matter, or null when it does not open with any.
 */
function bodyStart(doc: ProseNode): Selection | null {
  const first = doc.firstChild;
  if (first?.type.name !== FRONTMATTER_NODE) return null;
  return Selection.near(doc.resolve(first.nodeSize), 1);
}

/**
 * Keeps the caret out of the one place in front of the block: the document
 * start.
 *
 * ProseMirror's gap cursor counts that position as a gap a paragraph could
 * fill — the doc's content match there offers one — because nothing it checks
 * looks past the front matter that has to come first. So ArrowUp or ArrowLeft
 * from the top of the body put a gap cursor there, and the next keystroke was
 * dropped: a paragraph cannot sit above the metadata, so the insert had
 * nowhere to go and the file never changed. Any empty selection there, however
 * it got there, is moved to the top of the body, which for an arrow key reads
 * as "there is nothing above". A range from there (select-all) is left alone:
 * it is how the whole note, metadata included, is deleted.
 */
function caretBeforeFrontmatter(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!selection.empty || selection.$head.nodeAfter?.type.name !== FRONTMATTER_NODE) return null;
  const target = bodyStart(state.doc);
  return target ? state.tr.setSelection(target) : null;
}

const frontmatterGapPlugin = $prose(
  () =>
    new ProsePlugin({
      appendTransaction: (_transactions, _oldState, newState) => caretBeforeFrontmatter(newState),
    }),
);

/** The caret plugins, registered after {@link ./frontmatter}'s `frontmatterPlugins`. */
export const frontmatterCaretPlugins = [frontmatterClickPlugin, frontmatterGapPlugin];

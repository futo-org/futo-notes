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
import { GapCursor } from '@milkdown/kit/prose/gapcursor';
import { keydownHandler } from '@milkdown/kit/prose/keymap';
import {
  NodeSelection,
  Plugin as ProsePlugin,
  Selection,
  TextSelection,
} from '@milkdown/kit/prose/state';
import type { Command, EditorState, Transaction } from '@milkdown/kit/prose/state';
import type { Node as ProseNode, ResolvedPos } from '@milkdown/kit/prose/model';
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
          _nodePos: number,
        ): boolean => {
          if (node.type.name !== FRONTMATTER_NODE) return false;
          const after = bodyStart(view.state.doc);
          if (!after) return false;
          view.dispatch(view.state.tr.setSelection(after).scrollIntoView());
          return true;
        },
      },
    }),
);

/**
 * The first caret position in the BODY of a document that opens with front
 * matter, or null when it does not open with any.
 *
 * Always a caret, never a selection ON a block: when the body opens with a
 * selectable leaf (a divider), the nearest selection is a node selection on
 * it, and the next keystroke replaced it. The gap in front of that block is
 * the caret position there — typing at it writes a new paragraph above the
 * divider, as Ctrl+Home does in a note without front matter.
 */
function bodyStart(doc: ProseNode): Selection | null {
  const first = doc.firstChild;
  if (first?.type.name !== FRONTMATTER_NODE) return null;
  const $start = doc.resolve(first.nodeSize);
  const near = Selection.near($start, 1);
  // Not a text caret means no textblock opens the body, so the gap is a valid
  // one: the front matter atom closes it above, and a paragraph fits it.
  return near instanceof TextSelection ? near : new GapCursor($start);
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

/**
 * The selection {@link bodyStart} gives, or with `extend` the current one
 * stretched to it.
 *
 * A text selection cannot end in the gap in front of a divider that opens the
 * body, so an extended one stops at the body's first text and leaves the
 * divider out.
 */
function selectBodyStart(state: EditorState, target: Selection, extend: boolean): Transaction {
  const selection = extend ? TextSelection.between(state.selection.$anchor, target.$head) : target;
  return state.tr.setSelection(selection).scrollIntoView();
}

/**
 * Ctrl+Home (Cmd+Up on an Apple keyboard) to the top of the body; with Shift,
 * the selection is extended there instead.
 *
 * The browser's own document-start move looks for the first caret position in
 * the editable host, finds the `contenteditable="false"` panel there, and does
 * nothing at all — not even a `selectionchange` — so the next keystroke landed
 * wherever the caret already was. Declines in a note without front matter,
 * where the browser's move works.
 */
function toBodyStart(extend: boolean): Command {
  return (state, dispatch) => {
    const target = bodyStart(state.doc);
    if (!target) return false;
    dispatch?.(selectBodyStart(state, target, extend));
    return true;
  };
}

/**
 * Ctrl+ArrowUp, Shift+ArrowUp and Ctrl+Shift+ArrowUp at the top of the body:
 * to the top of the body, as at the top of a note without front matter.
 *
 * The browser makes these moves itself, and what it looks for above is inside
 * the `contenteditable="false"` panel, so it stopped partway along the first
 * line instead (`# Bo|dy`). Shift+ArrowUp acts from the first line of the
 * body; the Ctrl moves go a paragraph at a time, so they act from anywhere in
 * the first one. Plain ArrowUp does not need this: the gap cursor takes it,
 * and {@link caretBeforeFrontmatter} lands it here. Below a divider that opens
 * the body, an unshifted move first selects the divider (ProseMirror's own
 * step, as without front matter) and from there goes to the top of the body.
 */
function upToBodyStart(extend: boolean, byParagraph: boolean): Command {
  return (state, dispatch, view) => {
    const target = bodyStart(state.doc);
    if (!view || !target) return false;
    const { selection } = state;
    if (selection instanceof NodeSelection) {
      if (extend || selection.from !== target.from) return false;
    } else {
      const { $head } = selection;
      if (!$head.parent.isTextblock) return false;
      if (!extend && !(target instanceof TextSelection)) return false;
      const firstText = Selection.findFrom(target.$head, 1, true);
      if (firstText?.$head.start() !== $head.start()) return false;
      if (!byParagraph && !onFirstTextLine(view, $head)) return false;
    }
    dispatch?.(selectBodyStart(state, target, extend));
    return true;
  };
}

/**
 * Whether the head is on the first line of text in its textblock, where the
 * browser has nowhere above to go. Measured from the head rather than with
 * `endOfTextblock`, which looks at the top end of a selection, and from the
 * first text rather than the block's start: an image above it is
 * `contenteditable="false"`, no line the browser's caret can stop on.
 */
function onFirstTextLine(view: ProseView, $head: ResolvedPos): boolean {
  let firstText = -1;
  $head.parent.forEach((child, offset) => {
    if (firstText < 0 && child.isText) firstText = $head.start() + offset;
  });
  if (firstText < 0 || firstText >= $head.pos) return true;
  return view.coordsAtPos($head.pos).top < view.coordsAtPos(firstText, 1).bottom;
}

/**
 * The distance the browser's PageUp moves the caret: Chromium's
 * `MoveCommands::VerticalScrollDistance`, the smaller of the editor's and the
 * viewport's height less a 40px overlap (or 7/8 of it, whichever is further).
 */
function pageStep(view: ProseView): number {
  const height = Math.min(view.dom.clientHeight, document.documentElement.clientHeight);
  return Math.max(height * 0.875, height - 40, 1);
}

/**
 * PageUp (and Shift+PageUp) that would go past the top of the body: to the top
 * of the body, as a note without front matter goes to its start.
 *
 * The browser looks for the line a page up, finds none it can edit above the
 * body, and stopped partway along the first line (`# Bo|dy`), or below a
 * divider did not move at all. A PageUp that lands inside the body is the
 * browser's own.
 */
function pageUpPastTop(extend: boolean): Command {
  return (state, dispatch, view) => {
    const target = bodyStart(state.doc);
    if (!view || !target) return false;
    const caretTop = view.coordsAtPos(state.selection.head).top;
    if (caretTop - pageStep(view) >= view.coordsAtPos(target.head).top) return false;
    dispatch?.(selectBodyStart(state, target, extend));
    return true;
  };
}

const frontmatterBodyStartKeys = $prose(
  () =>
    new ProsePlugin({
      props: {
        handleKeyDown: keydownHandler({
          'Ctrl-Home': toBodyStart(false),
          'Ctrl-Shift-Home': toBodyStart(true),
          'Meta-ArrowUp': toBodyStart(false),
          'Meta-Shift-ArrowUp': toBodyStart(true),
          'Ctrl-ArrowUp': upToBodyStart(false, true),
          'Shift-ArrowUp': upToBodyStart(true, false),
          'Ctrl-Shift-ArrowUp': upToBodyStart(true, true),
          PageUp: pageUpPastTop(false),
          'Shift-PageUp': pageUpPastTop(true),
        }),
      },
    }),
);

/** The caret plugins, registered after {@link ./frontmatter}'s `frontmatterPlugins`. */
export const frontmatterCaretPlugins = [
  frontmatterClickPlugin,
  frontmatterGapPlugin,
  frontmatterBodyStartKeys,
];

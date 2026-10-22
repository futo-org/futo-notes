/** Front matter is an unselectable atom; clicks and navigation land in the body. */
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

/** Keep a caret before a leading divider: selecting that node would let typing replace it. */
function bodyStart(doc: ProseNode): Selection | null {
  const first = doc.firstChild;
  if (first?.type.name !== FRONTMATTER_NODE) return null;
  const $start = doc.resolve(first.nodeSize);
  const near = Selection.near($start, 1);
  // Not a text caret means no textblock opens the body, so the gap is a valid
  // one: the front matter atom closes it above, and a paragraph fits it.
  return near instanceof TextSelection ? near : new GapCursor($start);
}

/** A gap above required front matter cannot accept typing. Preserve ranges for select-all. */
function caretBeforeFrontmatter(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!selection.empty || selection.$head.nodeAfter?.type.name !== FRONTMATTER_NODE) return null;
  const target = bodyStart(state.doc);
  return target ? state.tr.setSelection(target) : null;
}

/** Extended text selections stop at the first body text, past any leading divider. */
function selectBodyStart(state: EditorState, target: Selection, extend: boolean): Transaction {
  const selection = extend ? TextSelection.between(state.selection.$anchor, target.$head) : target;
  return state.tr.setSelection(selection).scrollIntoView();
}

/** Native document-start navigation stops at the noneditable front matter panel. */
function toBodyStart(extend: boolean): Command {
  return (state, dispatch) => {
    const target = bodyStart(state.doc);
    if (!target) return false;
    dispatch?.(selectBodyStart(state, target, extend));
    return true;
  };
}

/** Override upward moves only in the first body textblock (or its leading divider).
 * Shift+ArrowUp is line-based; Ctrl+ArrowUp is paragraph-based. */
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

/** Measure from the selection head and first text, skipping noneditable images above it. */
function onFirstTextLine(view: ProseView, $head: ResolvedPos): boolean {
  let firstText = -1;
  $head.parent.forEach((child, offset) => {
    if (firstText < 0 && child.isText) firstText = $head.start() + offset;
  });
  if (firstText < 0 || firstText >= $head.pos) return true;
  return view.coordsAtPos($head.pos).top < view.coordsAtPos(firstText, 1).bottom;
}

/** Chromium's page distance: viewport minus 40px overlap, or 7/8 of its height. */
function pageStep(view: ProseView): number {
  const height = Math.min(view.dom.clientHeight, document.documentElement.clientHeight);
  return Math.max(height * 0.875, height - 40, 1);
}

/** Clamp PageUp at the body start; leave moves landing inside the body to the browser. */
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

const frontmatterCaretPlugin = $prose(
  () =>
    new ProsePlugin({
      appendTransaction: (_transactions, _oldState, newState) => caretBeforeFrontmatter(newState),
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
export const frontmatterCaretPlugins = [frontmatterCaretPlugin];

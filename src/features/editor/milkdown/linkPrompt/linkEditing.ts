import type { Editor } from '@milkdown/kit/core';
import { toggleLinkCommand } from '@milkdown/kit/preset/commonmark';
import type { Mark as ProseMark, Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { callCommand } from '@milkdown/kit/utils';

/** A link's whole run of text, and the mark that carries its href. */
export interface LinkRun {
  from: number;
  to: number;
  mark: ProseMark;
}

/** Update the whole existing link, or wrap the selection in a new one. */
export function applyLinkToSelection(
  editor: Editor,
  view: ProseView,
  run: LinkRun | null,
  href: string | null,
): void {
  if (run) {
    const { state } = view;
    const linkType = run.mark.type;
    if (href === null || href === '') {
      view.dispatch(state.tr.removeMark(run.from, run.to, linkType));
    } else if (href !== run.mark.attrs.href) {
      view.dispatch(
        state.tr
          .removeMark(run.from, run.to, linkType)
          .addMark(run.from, run.to, linkType.create({ ...run.mark.attrs, href })),
      );
    }
  } else if (href !== null && href !== '') {
    editor.action(callCommand(toggleLinkCommand.key, { href }));
  }
  view.focus();
}

/** Adjacent inline nodes carrying the same link mark, across other mark changes. */
export function linkRunAt(doc: ProseNode, pos: number): LinkRun | null {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const link = $pos.marks().find((mark) => mark.type.name === 'link');
  if (!link) return null;
  let offset = $pos.start();
  let from = -1;
  let to = -1;
  for (let index = 0; index < parent.childCount; index += 1) {
    const child = parent.child(index);
    const childTo = offset + child.nodeSize;
    if (link.isInSet(child.marks)) {
      if (from === -1) from = offset;
      to = childTo;
    } else {
      // A gap after the caret's run ends the search; a later equal mark is a
      // different link. Fragment.forEach cannot stop at this gap.
      if (to >= pos) break;
      from = -1;
      to = -1;
    }
    offset = childTo;
  }
  return from === -1 || pos < from || pos > to ? null : { from, to, mark: link };
}

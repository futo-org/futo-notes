/*
 * When the desktop selection toolbar shows, and what it shows for.
 *
 * Pure document logic — no DOM, no Milkdown, no editor lifecycle — so the rule
 * is unit-testable on its own (`target.test.ts`) and `index.ts` only has to
 * render and position. It runs on every transaction, i.e. every keystroke
 * (AGENTS.md M5): everything here is O(selection depth), never a document walk.
 */
import type { Mark as ProseMark, Node as ProseNode } from '@milkdown/kit/prose/model';
import { TextSelection, type EditorState } from '@milkdown/kit/prose/state';

import { blockFormatAtPos } from '../blockCommands';

/**
 * Whether this editor instance mounts the selection toolbar.
 *
 * Desktop only. The native shells have a real formatting toolbar docked over
 * the keyboard (packages/editor/src/toolbar.ts) — that IS their formatting
 * surface — and a phone's own selection UI (handles, the copy/paste callout)
 * already sits exactly where a floating bar would go. Same gate, same reason,
 * as the `/` menu (`resolveSlashMenu`); named here because `src/AGENTS.md` says
 * components never branch on platform.
 */
export function resolveSelectionToolbar(nativeShell: boolean): 'enabled' | 'disabled' {
  return nativeShell ? 'disabled' : 'enabled';
}

/** The selection the toolbar acts on. */
export interface SelectionToolbarTarget {
  from: number;
  to: number;
  /**
   * The href of the link the selection sits in, `null` when it is in none.
   * Read off the marks at the selection's head — the toolbar edits THAT link —
   * so a selection that merely brushes a link's edge still reports it, the same
   * way `formatState` lights the Link button for it.
   */
  linkHref: string | null;
}

/**
 * The range the toolbar formats, or null when the toolbar should be hidden.
 *
 * Shown for a non-empty TEXT selection that holds something to format: a
 * NodeSelection (an image, a wikilink chip, a whole block picked up by the ⠿
 * handle) offers nothing inline to toggle, a selection made only of whitespace
 * is the reader dragging across a gap, and inside a fenced code block nothing
 * is markup (docs/spec/editor.md "Code / fence isolation") — the toolbar there
 * would offer commands the editor refuses to apply.
 */
export function selectionToolbarTarget(state: EditorState): SelectionToolbarTarget | null {
  const { selection, doc } = state;
  if (!(selection instanceof TextSelection) || selection.empty) return null;
  const { from, to } = selection;
  if (blockFormatAtPos(selection.$from).kind === 'code') return null;
  if (blockFormatAtPos(selection.$to).kind === 'code') return null;
  if (doc.textBetween(from, to, ' ', ' ').trim() === '') return null;
  return { from, to, linkHref: linkHrefAt(selection.$head.marks()) };
}

function linkHrefAt(marks: readonly ProseMark[]): string | null {
  const link = marks.find((mark) => mark.type.name === 'link');
  if (!link) return null;
  const href = link.attrs.href;
  return typeof href === 'string' ? href : '';
}

/** A link's whole run of text, and the mark that carries its href. */
export interface LinkRun {
  from: number;
  to: number;
  mark: ProseMark;
}

/**
 * The whole run of the link that `pos` sits in — every adjacent inline node in
 * the same textblock carrying that SAME link mark — or null when `pos` is in
 * no link. Editing a link's href has to cover the whole run, not just the part
 * that happens to be selected: a range-only update would split one link into
 * two with different addresses. (Milkdown's `updateLinkCommand` covers only the
 * one text node under the selection and then collapses the selection, which is
 * why the toolbar does not use it.)
 */
export function linkRunAt(doc: ProseNode, pos: number): LinkRun | null {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const link = $pos.marks().find((mark) => mark.type.name === 'link');
  if (!link) return null;
  const start = $pos.start();
  let from = -1;
  let to = -1;
  parent.forEach((child, offset) => {
    const carries = link.isInSet(child.marks);
    const childFrom = start + offset;
    const childTo = childFrom + child.nodeSize;
    if (!carries) {
      // A gap before the caret's run resets; one after it ends the run.
      if (to !== -1 && childFrom >= pos) return;
      if (childTo <= pos) {
        from = -1;
        to = -1;
      }
      return;
    }
    if (from === -1) from = childFrom;
    to = childTo;
  });
  return from === -1 || pos < from || pos > to ? null : { from, to, mark: link };
}

/*
 * When the desktop selection toolbar shows, and what it shows for.
 *
 * Pure document logic — no DOM, no Milkdown, no editor lifecycle — so the rule
 * is unit-testable on its own (`target.test.ts`) and `index.ts` only has to
 * render and position. It runs on every transaction, i.e. every keystroke
 * (AGENTS.md M5): everything here is O(selection depth), never a document walk.
 */
import type { Mark as ProseMark } from '@milkdown/kit/prose/model';
import { TextSelection, type EditorState } from '@milkdown/kit/prose/state';

import { blockFormatAtPos } from '../blockCommands';
import { findSuppressesSelectionToolbar } from '../find/findPlugin';

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
  /* Find's own step SELECTS its match, and a floating format bar popping up on
   * every step would sit over the text the user is reading (docs/spec/editor.md
   * "Find in note"). The bar stays down for the whole time find is open,
   * including for the selection find leaves behind after Escape — the next
   * selection the user makes raises it normally, because closing find is what
   * lifts this gate. */
  if (findSuppressesSelectionToolbar(state)) return null;
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

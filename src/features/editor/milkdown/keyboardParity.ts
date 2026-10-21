/*
 * Keyboard behavior of the editor's interactive elements
 * (docs/spec/editor.md "Interactive elements", issue #108):
 *
 * - Enter in a table cell moves the caret down to the same column of the row
 *   below; only on the LAST row — where there is no row below — does it
 *   append a new one and move into that instead (QA lane 7, 2026-09:
 *   "Enter will create new row" no matter where the caret was, the previous
 *   behavior here, was the reported bug). The grip menu
 *   (`table/tableGrips.ts`) is the deliberate replacement for adding a row
 *   anywhere but the end, since the native shells have no right-click cell
 *   context menu. The gfm preset instead bound bare Enter to `exitTable`,
 *   which dropped a stray empty paragraph after the table.
 * - Tab at the very last cell appends a row instead of falling through to the
 *   browser's default Tab, which moved focus out of the editor and silently
 *   swallowed whatever was typed next.
 * - Tab/Shift-Tab inside a CODE BLOCK insert/remove two spaces of indentation
 *   (QA #011) instead of falling through to the browser — the preset binds
 *   Tab only inside lists (`sinkListItemCommand`) and tables, so a fence got
 *   nothing and Tab moved focus out of the editor (to the block's own ⋮ menu),
 *   silently swallowing whatever was typed next. Escape THEN Tab is the
 *   documented way out of that trap for a keyboard-only user: Escape arms a
 *   one-shot flag that makes the very next Tab fall through to the browser
 *   instead of inserting spaces, exactly as if this module were not here;
 *   typing any other key disarms it. Blockquotes and tables are a deliberate
 *   NON-claim — Tab stays ordinary focus navigation there (only a code fence
 *   traps it today), so this is the only new Tab claimant.
 * - Splitting a checked task item starts the new item UNCHECKED —
 *   ProseMirror's `splitListItem`
 *   otherwise clones the `checked: true` attr onto the new item.
 *
 * QA #004 (Backspace at the start of a nested list item keeps its
 * indentation rather than merging everything into the top-level item) needed
 * NO new code here: the preset's own `liftFirstListItemCommand`
 * (`joinBackward`) already produces exactly that — `list_item` is
 * `defining: true` in the schema, so `joinBackward`'s generic lift keeps a
 * nested item's content inside its enclosing item instead of merging past it.
 * Verified end-to-end against the real bundle for the plain case, a second
 * Backspace, a top-level item, and both a following- and a preceding-sibling
 * nested item; pinned in `tests/editor-embed-milkdown-interactive.spec.ts`.
 *
 * Wired as the ProseMirror `handleKeyDown` DIRECT view prop (via
 * `editorViewOptionsCtx` in editorPlugins.ts) rather than a keymap
 * plugin, for the same reason `handlePaste` is: direct props are consulted
 * before every plugin keymap, so this wins deterministically over the preset's
 * own Enter/Tab bindings without depending on plugin registration order.
 * While the `[[` suggestion popup is open, Enter and Tab are the popup's
 * (accept), so this module declines both.
 * Enter, Shift+Enter, Backspace and Delete in a top-level paragraph follow the
 * newline model of `paragraphLines.ts`: Enter writes one newline, Shift+Enter
 * is the same key (it is replayed as a plain Enter everywhere but a table cell,
 * so it never makes a `\` hard break), and Backspace/Delete at a paragraph
 * boundary remove one newline. While the `/` menu is open, Enter and Tab are
 * its, as they are the `[[` popup's.
 *
 * Everything it does not explicitly claim falls through untouched —
 * Mod-Enter's `exitTable`, Tab/Shift-Tab cell and list navigation, Backspace
 * and Delete inside a block, and the list-split Enter for plain and unchecked
 * items.
 */
import { keydownHandler } from '@milkdown/kit/prose/keymap';
import { splitListItem } from '@milkdown/kit/prose/schema-list';
import { type Command } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { changeBlockIndent, selectionTouchesCode } from './blockCommands';
import { enclosingListItem } from './caretContext';
import { enterInParagraph, joinBackwardAsLine, joinForwardAsLine } from './paragraphLines';
import { isSlashMenuOpen } from './slash';
import { isWikilinkSuggestOpen } from './wikilink/autocomplete';
import {
  appendTableRowFromLastCell,
  insertLineBreakInTableCell,
  insertTableRowBelow,
} from './keyboardParityTable';
import { indentCodeBlockOnTab, outdentCodeBlockOnShiftTab } from './keyboardParityCode';

/**
 * Enter in a CHECKED task item: split with the new item unchecked. An
 * unchecked or non-task item declines — the default split already clones
 * `checked: false` / `null` correctly.
 */
const splitCheckedTaskItem: Command = (state, dispatch) => {
  const item = enclosingListItem(state.selection);
  if (!item || item.node.attrs.checked !== true) return false;
  return splitListItem(item.node.type, { ...item.node.attrs, checked: false })(state, dispatch);
};

/**
 * One-shot "let the next Tab escape the editor" flag, per view — the
 * accessibility hatch QA #011 requires: claiming Tab inside a fence traps a
 * keyboard-only user who has no other way to leave the editor, so Escape
 * arms this, and the very next Tab (whether or not it would otherwise have
 * been claimed) is let through to the browser's default focus-move instead.
 * Any other key disarms it, so the arm only ever survives exactly one
 * intervening Escape-then-Tab pair. A `WeakMap` keyed by view rather than one
 * module-level boolean, because more than one Milkdown editor can be mounted
 * at once (e.g. a preview pane) and Escape in one must not arm Tab in another.
 */
const tabEscapeArmed = new WeakMap<ProseView, boolean>();

/**
 * Shift+Enter outside a table cell: run whatever plain Enter does at the caret
 * — a newline, a list split, a new paragraph after a heading, a newline in code
 * — by offering every key handler a plain Enter. Always claims the key, so the
 * preset's own Shift-Enter binding (a `\` hard break) never runs.
 */
function replayAsEnter(view: ProseView): boolean {
  const enter = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
  });
  view.someProp('handleKeyDown', (handle) => handle(view, enter));
  return true;
}

/**
 * The `handleKeyDown` direct view prop. Returns true only when one of the
 * parity commands above actually handled the key.
 */
export function handleParityKeyDown(view: ProseView, event: KeyboardEvent): boolean {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;

  if (event.key === 'Escape') {
    tabEscapeArmed.set(view, true);
    return false;
  }
  const armed = tabEscapeArmed.get(view) === true;
  if (event.key !== 'Tab') tabEscapeArmed.delete(view);

  /* An open `[[` suggestion popup or `/` menu owns Enter and Tab (take the
   * highlighted row). Their handlers are plugin props and this is a direct
   * prop, which runs first, so without this a checked task item split / a
   * table-cell Enter / a paragraph newline won over the pick and the typed
   * query stayed as literal text (RC-20). */
  if (
    (event.key === 'Enter' || event.key === 'Tab') &&
    (isWikilinkSuggestOpen(view.state) || isSlashMenuOpen(view))
  ) {
    tabEscapeArmed.delete(view);
    // Shift+Enter is Enter here too: the pick, never a `\` hard break.
    return event.key === 'Enter' && event.shiftKey ? replayAsEnter(view) : false;
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    return (
      insertTableRowBelow(view.state, view.dispatch) ||
      splitCheckedTaskItem(view.state, view.dispatch) ||
      enterInParagraph(view.state, view.dispatch)
    );
  }
  if (event.key === 'Enter' && event.shiftKey) {
    return insertLineBreakInTableCell(view.state, view.dispatch) || replayAsEnter(view);
  }
  if (event.key === 'Backspace') return joinBackwardAsLine(view.state, view.dispatch);
  if (event.key === 'Delete') return joinForwardAsLine(view.state, view.dispatch);
  if (event.key === 'Tab') {
    tabEscapeArmed.delete(view);
    // The escape hatch overrides the code-fence claim below — it exists
    // precisely so a keyboard-only user can never be trapped in one.
    if (armed) return false;
    if (!event.shiftKey && appendTableRowFromLastCell(view.state, view.dispatch)) return true;
    return event.shiftKey
      ? outdentCodeBlockOnShiftTab(view.state, view.dispatch)
      : indentCodeBlockOnTab(view.state, view.dispatch);
  }
  return false;
}

/*
 * Desktop keyboard shortcuts for Indent/Outdent — the standard editor
 * convention (Mod+] / Mod+[), and independent of the Tab decision above: Tab
 * stays plain focus navigation everywhere but a code fence, this claims two
 * keys Tab never touched. Wired from its own `handleKeyDown` slot in
 * editorPlugins.ts (composed ahead of `handleParityKeyDown`, which bails
 * out on any modifier key and so never sees these), not from inside
 * `handleParityKeyDown` above.
 */

/** Whether `event` is the Indent/Outdent chord — Cmd or Ctrl, no other modifier, `]`/`[`. */
function isIndentShortcut(event: KeyboardEvent): 1 | -1 | null {
  if (event.shiftKey || event.altKey) return null;
  if (!event.metaKey && !event.ctrlKey) return null;
  if (event.key === ']') return 1;
  if (event.key === '[') return -1;
  return null;
}

/**
 * The `handleKeyDown` direct view prop for Mod+]/Mod+[. Declines (returns
 * false) for any other key, or when the caret is not in a container
 * `changeBlockIndent` can act on — same containers the `cursorContext` bridge
 * message and the desktop selection toolbar report (blockCommands.ts
 * `inIndentableContainer`).
 */
export function handleIndentShortcut(view: ProseView, event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  const direction = isIndentShortcut(event);
  if (direction === null) return false;
  return changeBlockIndent(direction)(view.state, view.dispatch);
}

/*
 * The commonmark preset's block-type chords — Text (Mod-Alt-0), Heading 1-6
 * (Mod-Alt-1…6), Ordered (Mod-Alt-7), Bullet (Mod-Alt-8), Quote (Mod-Shift-b)
 * and Code (Mod-Alt-c) — are bare `setBlockType`/`wrapIn`s, so with the caret
 * in a fence they rewrote it: a heading or paragraph of its lines joined by
 * spaces, a `>`-wrapped fence, the language dropped — and over a selection
 * spanning a fence, the lists swallowed it too (ed-24). A fence is literal
 * text, which no block format applies to (blockCommands.ts, and
 * docs/spec/editor.md "A block-format command never touches a CODE BLOCK"),
 * so these chords do nothing while the selection touches one. The key is
 * still CLAIMED: the preset claims it everywhere else, and declining here
 * would hand it straight back to that preset's keymap. Key names are the
 * preset's own, matched by the same `keydownHandler` its keymap uses.
 */
const blockTypeChordsInCode = keydownHandler(
  Object.fromEntries(
    [0, 1, 2, 3, 4, 5, 6, 7, 8]
      .map((n) => `Mod-Alt-${n}`)
      .concat(['Mod-Shift-b', 'Mod-Alt-c'])
      .map((chord): [string, Command] => [chord, (state) => selectionTouchesCode(state)]),
  ),
);

/**
 * The `handleKeyDown` direct view prop for the preset's block-type chords:
 * claims one, changing nothing, when the selection touches a code block;
 * declines everywhere else so the preset runs as before.
 */
export function handleBlockTypeChordInCode(view: ProseView, event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  return blockTypeChordsInCode(view, event);
}

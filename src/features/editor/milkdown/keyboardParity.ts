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
 * - Enter in a code block is a newline in it, inside a list item too: the
 *   preset's list split runs before the base keymap's `newlineInCode`, and on
 *   a fence's last line it closed the fence and started a new item.
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
import type { Ctx } from '@milkdown/kit/ctx';
import { headingKeymap, listItemKeymap } from '@milkdown/kit/preset/commonmark';
import { newlineInCode } from '@milkdown/kit/prose/commands';
import { keydownHandler } from '@milkdown/kit/prose/keymap';
import { splitListItem } from '@milkdown/kit/prose/schema-list';
import { type Command } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import {
  changeBlockIndent,
  selectionTouchesCode,
  selectionWithinWrittenContent,
} from './blockCommands';
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
 * Enter in a CHECKED task item: split it so the NEW item is unchecked and the
 * item being left keeps its state (docs/spec/editor/interactive-elements.md).
 * Which half is new depends on where the caret was: at the very start of the
 * item's text, the text moves down WITH the caret, so the new item is the
 * empty one left above; anywhere else the caret leaves the upper half and the
 * new item is the lower one. A selection is deleted first and Enter then acts
 * where it started, so a selection from the start of the text, even one
 * covering all of it, counts as a caret there. `splitListItem` alone cannot
 * say that — it applies its `itemAttrs` only to an end-of-item split and
 * clones `checked: true` onto both halves everywhere else — so the attrs are
 * set on its transaction. An unchecked or non-task item declines — the default split
 * already clones `checked: false` / `null` correctly — and so does an empty
 * last line, which `splitListItem` answers by leaving the list or splitting
 * the WRAPPING item, cloning nothing from this one.
 */
const splitCheckedTaskItem: Command = (state, dispatch) => {
  const item = enclosingListItem(state.selection);
  if (!item || item.node.attrs.checked !== true) return false;
  const { $from } = state.selection;
  if ($from.depth < 2 || $from.node(-1) !== item.node) return false;
  if ($from.parent.content.size === 0 && $from.indexAfter(-1) === item.node.childCount) {
    return false;
  }
  const newItemAbove = $from.parentOffset === 0 && $from.index(-1) === 0;
  return splitListItem(item.node.type)(
    state,
    dispatch &&
      ((tr) => {
        const upper = tr.doc.nodeAt(item.pos);
        if (upper) {
          const newPos = newItemAbove ? item.pos : item.pos + upper.nodeSize;
          const newItem = tr.doc.nodeAt(newPos);
          if (newItem?.type === item.node.type) {
            tr.setNodeMarkup(newPos, undefined, { ...newItem.attrs, checked: false });
          }
        }
        dispatch(tr);
      }),
  );
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
      newlineInCode(view.state, view.dispatch) ||
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
 *
 * A selection reaching past the note's written content (select-all over a
 * note ending in a list or quote) is first narrowed to that content, then the
 * preset runs on it: otherwise the parked trailing paragraph became a saved
 * `#` or an empty fence (blockCommands.ts `selectionWithinWrittenContent`).
 * With no written textblock in it, the chord is claimed and does nothing.
 */
const blockTypeChordGuard: Command = (state, dispatch) => {
  if (selectionTouchesCode(state)) return true;
  const scope = selectionWithinWrittenContent(state);
  if (scope === state.selection) return false;
  if (!scope) return true;
  dispatch?.(state.tr.setSelection(scope));
  return false;
};

const blockTypeChords = keydownHandler(
  Object.fromEntries(
    [0, 1, 2, 3, 4, 5, 6, 7, 8]
      .map((n) => `Mod-Alt-${n}`)
      .concat(['Mod-Shift-b', 'Mod-Alt-c'])
      .map((chord): [string, Command] => [chord, blockTypeChordGuard]),
  ),
);

/**
 * The `handleKeyDown` direct view prop for the preset's block-type chords:
 * claims one, changing nothing, when the selection touches a code block;
 * narrows a selection that runs past the written content; declines otherwise
 * so the preset runs as before.
 */
export function handleBlockTypeChord(view: ProseView, event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  return blockTypeChords(view, event);
}

/*
 * Delete is a FORWARD delete in a list item and in a heading, as it is in a
 * paragraph: at the start of the text it removes the next character. The
 * commonmark preset binds the two commands that belong to Backspace at the
 * start of a block — lift the first list item out of its list, take one level
 * off a heading — to Delete as well, so Delete there lifted the item or
 * downgraded the heading and deleted nothing. This keeps them on Backspace
 * only, through the preset's own keymap configuration (each `$useKeymap`'s ctx
 * slice), before its shortcuts are built. Called from the editor's `.config()`.
 * `keyboardParity.preset.test.ts` holds the canary: when upstream stops binding
 * Delete there, this can go.
 */
const withoutDelete = (shortcuts: string | string[]): string[] =>
  [shortcuts].flat().filter((key) => key !== 'Delete');

export function keepDeleteForward(ctx: Ctx): void {
  ctx.update(listItemKeymap.key, (keys) => ({
    ...keys,
    LiftFirstListItem: {
      ...keys.LiftFirstListItem,
      shortcuts: withoutDelete(keys.LiftFirstListItem.shortcuts),
    },
  }));
  ctx.update(headingKeymap.key, (keys) => ({
    ...keys,
    DowngradeHeading: {
      ...keys.DowngradeHeading,
      shortcuts: withoutDelete(keys.DowngradeHeading.shortcuts),
    },
  }));
}

/*
 * A shortcut held with Shift never runs the same shortcut without Shift,
 * whatever the Caps Lock state. With Caps Lock on, a Shift chord's key arrives
 * as a LOWERCASE letter, and prosemirror-keymap answers a lowercase letter
 * with Shift held by running the `Shift-` binding and, when none claims it,
 * retrying the chord WITHOUT Shift. So Redo with nothing to redo undid the last
 * edit, Ctrl+Shift+B in a table cell turned on bold, Ctrl+Shift+I ran Italic
 * and Ctrl+Alt+Shift+X ran Strikethrough. With Caps Lock off the key arrives
 * uppercase and that retry never matches a binding.
 *
 * So the chord is offered to every key handler again as the uppercase key the
 * same keys send with Caps Lock off, which is exactly what they do then, and
 * the lowercase original is claimed so it never reaches the retry. Not on an
 * Apple platform for a Cmd+Shift chord: the keymap reads that key from its key
 * code there (w3c-keyname), so it already arrives shifted. Not for AltGr,
 * which types characters, nor for a key that is not a plain a-z letter.
 */
const applePlatform =
  typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

function isCapsLockedChord(event: KeyboardEvent): boolean {
  if (event.isComposing || !event.shiftKey || !/^[a-z]$/.test(event.key)) return false;
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return false;
  if (event.getModifierState('AltGraph')) return false;
  return !(applePlatform && event.metaKey && !event.ctrlKey && !event.altKey);
}

/** The `handleKeyDown` direct view prop for a Shift chord sent with Caps Lock on. */
export function handleCapsLockedChord(view: ProseView, event: KeyboardEvent): boolean {
  if (!isCapsLockedChord(event)) return false;
  const shifted = new KeyboardEvent('keydown', {
    key: event.key.toUpperCase(),
    code: event.code,
    shiftKey: true,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    bubbles: true,
    cancelable: true,
  });
  // prosemirror-keymap matches a Shift chord through the key code; the
  // constructor leaves it 0.
  Object.defineProperty(shifted, 'keyCode', { value: event.keyCode });
  view.someProp('handleKeyDown', (handle) => handle(view, shifted));
  return true;
}

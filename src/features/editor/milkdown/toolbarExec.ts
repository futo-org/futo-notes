/*
 * The shared toolbar manifest's command ids, executed as Milkdown/ProseMirror
 * commands.
 *
 * The manifest (packages/editor/src/toolbar.ts) is the single source of the
 * toolbar surface for every shell (M10); `TOOLBAR_EXEC` there implements each
 * id for CodeMirror. This is the same id set implemented for the Milkdown
 * editor, reached through the editor handle's `exec()` — the embed toolbar and
 * both native toolbars call one of the two depending on which engine is
 * mounted, never a per-shell copy.
 *
 * Command parity against the manifest is not finished: `link` with an empty
 * selection and `indent` on a list item with no preceding sibling are known
 * gaps, owned by the toolbar-parity ticket (#104).
 */
import { editorViewCtx, type CmdKey, type Editor } from '@milkdown/kit/core';
import {
  liftListItemCommand,
  sinkListItemCommand,
  toggleEmphasisCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { callCommand } from '@milkdown/kit/utils';

import { currentHeadingLevel, enclosingListItem } from './caretContext';

/** Command ids this editor can execute, mapped to their implementations. */
export type ToolbarExecMap = Record<string, () => void>;

export function createToolbarExec(getEditor: () => Editor | null): ToolbarExecMap {
  function view(): ProseView | null {
    const editor = getEditor();
    if (!editor) return null;
    try {
      return editor.ctx.get(editorViewCtx);
    } catch {
      return null;
    }
  }

  function run<T>(command: { key: CmdKey<T> }, payload?: T): void {
    const editor = getEditor();
    if (!editor) return;
    editor.action(callCommand(command.key, payload));
    view()?.focus();
  }

  function listItem(): { node: import('@milkdown/kit/prose/model').Node; pos: number } | null {
    const current = view();
    return current ? enclosingListItem(current) : null;
  }

  function setListItemChecked(value: boolean | null): void {
    const current = view();
    const item = listItem();
    if (!current || !item) return;
    current.dispatch(
      current.state.tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: value }),
    );
  }

  return {
    bold: () => run(toggleStrongCommand),
    italic: () => run(toggleEmphasisCommand),
    strikethrough: () => run(toggleStrikethroughCommand),
    link: () => run(toggleLinkCommand, { href: '' }),
    heading: () => {
      const current = view();
      const level = current ? currentHeadingLevel(current) : 0;
      // Cycles H1 -> H2 -> H3 -> body, matching the CodeMirror toolbar.
      if (level >= 3) run(turnIntoTextCommand);
      else run(wrapInHeadingCommand, level + 1);
    },
    quote: () => run(wrapInBlockquoteCommand),
    'bullet-list': () => run(wrapInBulletListCommand),
    'ordered-list': () => run(wrapInOrderedListCommand),
    'task-list': () => {
      // A task item IS a bullet item with a `checked` attribute, so a plain
      // paragraph has to become a list first.
      if (!listItem()) run(wrapInBulletListCommand);
      const current = listItem()?.node.attrs.checked ?? null;
      setListItemChecked(current === null ? false : null);
      view()?.focus();
    },
    indent: () => run(sinkListItemCommand),
    outdent: () => run(liftListItemCommand),
  };
}

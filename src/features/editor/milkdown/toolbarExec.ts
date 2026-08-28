/*
 * The shared toolbar manifest's command ids, executed as Milkdown/ProseMirror
 * commands.
 *
 * The manifest (packages/editor/src/toolbar.ts) is the single source of the
 * toolbar surface for every shell (M10); `TOOLBAR_EXEC` in
 * `src/features/editor/markdownToolbar.ts` implements each id for CodeMirror.
 * This is the same id set implemented for the Milkdown editor, reached through
 * the editor handle's `exec()` — the embed toolbar and both native toolbars
 * call one of the two depending on which engine is mounted, never a per-shell
 * copy.
 *
 * Inline marks map onto the preset's own commands. The BLOCK commands do not:
 * the preset ships bare `wrapIn`/`wrapInList` wrappers with no toggle and no
 * conversion, so they live in `blockCommands.ts`, which implements the
 * one-prefix-per-line model the spec describes
 * ([editor.md](../../../../docs/spec/editor.md) → "Markdown toolbar").
 */
import { type CmdKey, type Editor } from '@milkdown/kit/core';
import {
  liftListItemCommand,
  sinkListItemCommand,
  toggleEmphasisCommand,
  toggleLinkCommand,
  toggleStrongCommand,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
import type { Command as ProseCommand } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { callCommand } from '@milkdown/kit/utils';

import { blockCommand, type BlockCommandId } from './blockCommands';
import { editorView } from './caretContext';

/** Command ids this editor can execute, mapped to their implementations. */
export type ToolbarExecMap = Record<string, () => void>;

export function createToolbarExec(getEditor: () => Editor | null): ToolbarExecMap {
  const view = (): ProseView | null => editorView(getEditor());

  /** Run a Milkdown-registered command through the editor's command manager. */
  function run<T>(command: { key: CmdKey<T> }, payload?: T): void {
    const editor = getEditor();
    if (!editor) return;
    editor.action(callCommand(command.key, payload));
    view()?.focus();
  }

  /** Run a plain ProseMirror command against the live view. */
  function dispatch(command: ProseCommand): void {
    const current = view();
    if (!current) return;
    command(current.state, current.dispatch.bind(current));
    current.focus();
  }

  const block = (id: BlockCommandId) => () => dispatch(blockCommand(id));

  return {
    bold: () => run(toggleStrongCommand),
    italic: () => run(toggleEmphasisCommand),
    strikethrough: () => run(toggleStrikethroughCommand),
    // An empty selection arms the mark for the text typed next (ProseMirror
    // stored marks) — the WYSIWYG equivalent of CodeMirror's `[]()` scaffold,
    // which existed only so the caret had a source slot to sit in.
    link: () => run(toggleLinkCommand, { href: '' }),
    heading: block('heading'),
    quote: block('quote'),
    'bullet-list': block('bullet'),
    'ordered-list': block('ordered'),
    'task-list': block('task'),
    // Nesting is structural in ProseMirror: an item can only sink under a
    // preceding SIBLING item, so Indent is a no-op on the first item of a list.
    // Markdown source has no such rule, which is why the CodeMirror toolbar
    // could indent it — into a nested list with no parent.
    indent: () => run(sinkListItemCommand),
    outdent: () => run(liftListItemCommand),
  };
}

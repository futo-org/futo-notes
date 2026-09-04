/*
 * The `/` menu's item ids, executed as editor commands.
 *
 * Same split as the toolbar (`../toolbarExec.ts`, and the manifest note in
 * packages/editor/src/toolbar.ts): `items.ts` is the surface — which items
 * exist, in which order, matched how — and this is the one implementation of
 * each id. Neither file guesses what the other holds; `exec.test.ts` asserts
 * they cover exactly the same set.
 *
 * BLOCK FORMATS go through `setBlockFormat` in `../blockCommands.ts`, the same
 * transition table the toolbar buttons use, so the two surfaces cannot end up
 * disagreeing about what "quote" or "task list" means. The difference is
 * toggle vs set, and it lives in that module: a menu pick is an instruction,
 * not a toggle.
 *
 * INSERTS (code block, divider, table) are the presets' own commands rather
 * than hand-built nodes — a GFM table is a table > row > header/cell tree whose
 * shape belongs to `@milkdown/preset-gfm`, not to this menu.
 */
import type { CmdKey, Editor } from '@milkdown/kit/core';
import { createCodeBlockCommand, insertHrCommand } from '@milkdown/kit/preset/commonmark';
import { insertTableCommand } from '@milkdown/kit/preset/gfm';
import type { Command as ProseCommand } from '@milkdown/kit/prose/state';
import { callCommand } from '@milkdown/kit/utils';

import { setBlockFormat, type BlockFormat } from '../blockCommands';
import { editorView } from '../caretContext';

/** Item id → what picking it does. */
export type SlashExecMap = Record<string, () => void>;

export function createSlashExec(getEditor: () => Editor | null): SlashExecMap {
  /** Run a Milkdown-registered command through the editor's command manager. */
  function run<T>(command: { key: CmdKey<T> }, payload?: T): void {
    const editor = getEditor();
    if (!editor) return;
    editor.action(callCommand(command.key, payload));
    editorView(editor)?.focus();
  }

  /** Run a plain ProseMirror command against the live view. */
  function dispatch(command: ProseCommand): void {
    const view = editorView(getEditor());
    if (!view) return;
    command(view.state, view.dispatch.bind(view));
    view.focus();
  }

  const format = (target: BlockFormat) => () => dispatch(setBlockFormat(target));

  return {
    paragraph: format({ kind: 'none' }),
    'heading-1': format({ kind: 'heading', level: 1 }),
    'heading-2': format({ kind: 'heading', level: 2 }),
    'heading-3': format({ kind: 'heading', level: 3 }),
    'bullet-list': format({ kind: 'bullet' }),
    'ordered-list': format({ kind: 'ordered' }),
    'task-list': format({ kind: 'task' }),
    quote: format({ kind: 'quote' }),
    'code-block': () => run(createCodeBlockCommand),
    divider: () => run(insertHrCommand),
    // `row` COUNTS the header row (createTable makes row 0 the header), so this
    // is a header plus two body rows, three columns — a table someone can start
    // typing into, which is what picking "Table" off a menu means. Stated rather
    // than left to the preset's identical defaults, so a change there is visible
    // here.
    table: () => run(insertTableCommand, { row: 3, col: 3 }),
  };
}

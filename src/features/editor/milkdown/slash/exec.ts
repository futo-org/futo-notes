/*
 * What picking a `/` menu item DOES. `items.ts` says what the menu OFFERS;
 * `index.ts` renders it and calls one of these on a pick.
 *
 * Every item DELETES the typed `/query` run FIRST, then does its own thing —
 * `menu.ts`'s `commit()` hands each entry the run's `[from, to)` for exactly
 * that. A FORMAT item (paragraph, a heading, a list, quote) and a
 * RESTRUCTURING one (code block, divider, table) both go through
 * `commandRunner.ts`'s `runAfterDelete`/`runKeyAfterDelete`, which fold the
 * delete and the command into ONE transaction — see that module's header
 * comment for why the order used to matter and no longer does.
 *
 * Image and Link are the two ASYNCHRONOUS items: picking one opens a picker
 * or a prompt and returns immediately, so there is no "the command's own
 * transaction" to fold the delete into. Both delete the typed run
 * synchronously up front (`deleteRange`) and let the async result land at the
 * caret whenever it arrives — cancelling either (no file chosen, the Link
 * prompt dismissed) still leaves the typed run gone, never restored.
 */
import type { Editor } from '@milkdown/kit/core';
import { createCodeBlockCommand, insertHrCommand } from '@milkdown/kit/preset/commonmark';
import { insertTableCommand } from '@milkdown/kit/preset/gfm';
import { insert as insertMarkdown } from '@milkdown/kit/utils';
import { imageReferenceMarkdown } from '@futo-notes/editor';

import { resolveImageInserter } from '../../imageInsert';
import { setBlockFormat, type BlockFormat } from '../blockCommands';
import { editorView } from '../caretContext';
import { createCommandRunner } from '../commandRunner';
import { openLinkPrompt } from '../linkPrompt';

/** Item id → what picking it does, given the typed `/query` run's `[from, to)`. */
export type SlashExecMap = Record<string, (from: number, to: number) => void>;

export function createSlashExec(getEditor: () => Editor | null): SlashExecMap {
  const { runAfterDelete, runKeyAfterDelete, deleteRange } = createCommandRunner(getEditor);

  const format =
    (target: BlockFormat) =>
    (from: number, to: number): void => {
      runAfterDelete(from, to, setBlockFormat(target));
    };

  return {
    paragraph: format({ kind: 'none' }),
    'heading-1': format({ kind: 'heading', level: 1 }),
    'heading-2': format({ kind: 'heading', level: 2 }),
    'heading-3': format({ kind: 'heading', level: 3 }),
    'bullet-list': format({ kind: 'bullet' }),
    'ordered-list': format({ kind: 'ordered' }),
    'task-list': format({ kind: 'task' }),
    quote: format({ kind: 'quote' }),
    'code-block': (from, to) => {
      runKeyAfterDelete(from, to, createCodeBlockCommand);
    },
    divider: (from, to) => {
      runKeyAfterDelete(from, to, insertHrCommand);
    },
    // `row` COUNTS the header row (createTable makes row 0 the header), so this
    // is a header plus two body rows, three columns — a table someone can start
    // typing into, which is what picking "Table" off a menu means. Stated rather
    // than left to the preset's identical defaults, so a change there is visible
    // here.
    table: (from, to) => {
      runKeyAfterDelete(from, to, insertTableCommand, { row: 3, col: 3 });
    },
    /* Resolved per pick, not once per editor: the platform FS is initialized
     * during app bootstrap, and this plugin is built while the editor is still
     * being constructed — resolving it eagerly would cache "no picker" on a
     * host that has one. */
    image: (from, to) => {
      deleteRange(from, to);
      void resolveImageInserter((filename) => {
        const editor = getEditor();
        if (!editor) return;
        editor.action(insertMarkdown(imageReferenceMarkdown(filename)));
        editorView(editor)?.focus();
      }).pick();
    },
    // QA-019: shares the URL prompt the desktop selection toolbar's Link
    // button opens (`linkPrompt/`) rather than a second one — see that
    // module's header comment for what submitting or cancelling it does.
    link: (from, to) => {
      deleteRange(from, to);
      const editor = getEditor();
      if (!editor) return;
      openLinkPrompt(editor);
    },
  };
}

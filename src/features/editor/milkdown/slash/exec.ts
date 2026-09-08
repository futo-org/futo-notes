import type { Editor } from '@milkdown/kit/core';
import { createCodeBlockCommand, insertHrCommand } from '@milkdown/kit/preset/commonmark';
import { insertTableCommand } from '@milkdown/kit/preset/gfm';
import { insert as insertMarkdown } from '@milkdown/kit/utils';
import { imageReferenceMarkdown } from '@futo-notes/editor';

import { resolveImageInserter } from '../../imageInsert';
import { setBlockFormat, type BlockFormat } from '../blockCommands';
import { editorView } from '../caretContext';
import { createCommandRunner } from '../commandRunner';

/** Item id → what picking it does. */
export type SlashExecMap = Record<string, () => void>;

export function createSlashExec(getEditor: () => Editor | null): SlashExecMap {
  const { run, dispatch } = createCommandRunner(getEditor);

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
    /* Resolved per pick, not once per editor: the platform FS is initialized
     * during app bootstrap, and this plugin is built while the editor is still
     * being constructed — resolving it eagerly would cache "no picker" on a
     * host that has one. */
    image: () => {
      void resolveImageInserter((filename) => {
        const editor = getEditor();
        if (!editor) return;
        editor.action(insertMarkdown(imageReferenceMarkdown(filename)));
        editorView(editor)?.focus();
      }).pick();
    },
  };
}

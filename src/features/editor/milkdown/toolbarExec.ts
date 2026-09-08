import { type Editor } from '@milkdown/kit/core';
import {
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';

import { blockCommand, changeBlockIndent, type BlockCommandId } from './blockCommands';
import { createCommandRunner } from './commandRunner';

/** Command ids this editor can execute, mapped to their implementations. */
export type ToolbarExecMap = Record<string, () => void>;

export function createToolbarExec(getEditor: () => Editor | null): ToolbarExecMap {
  const { run, dispatch } = createCommandRunner(getEditor);

  const block = (id: BlockCommandId) => () => dispatch(blockCommand(id));

  return {
    bold: () => run(toggleStrongCommand),
    italic: () => run(toggleEmphasisCommand),
    strikethrough: () => run(toggleStrikethroughCommand),
    // Not in the mobile manifest (the phone keyboards' own toolbars never had
    // it); the desktop selection toolbar's fifth button, implemented here so
    // every surface that offers it runs the one command (M10).
    code: () => run(toggleInlineCodeCommand),
    // An empty selection arms the mark for the text typed next (ProseMirror
    // stored marks) — the WYSIWYG equivalent of CodeMirror's `[]()` scaffold,
    // which existed only so the caret had a source slot to sit in.
    link: () => run(toggleLinkCommand, { href: '' }),
    'heading-1': block('heading-1'),
    'heading-2': block('heading-2'),
    'heading-3': block('heading-3'),
    paragraph: block('paragraph'),
    quote: block('quote'),
    'bullet-list': block('bullet'),
    'ordered-list': block('ordered'),
    'task-list': block('task'),
    indent: () => dispatch(changeBlockIndent(1)),
    outdent: () => dispatch(changeBlockIndent(-1)),
  };
}

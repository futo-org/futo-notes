import { type Editor } from '@milkdown/kit/core';
import {
  createCodeBlockCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
import { redo, undo } from '@milkdown/kit/prose/history';

import { blockCommand, changeBlockIndent, type BlockCommandId } from './blockCommands';
import { createCommandRunner } from './commandRunner';
import { openLinkPrompt } from './linkPrompt';

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
    // QA-005: an empty href (or a bare toggle) is not a usable link on a
    // shell with no Markdown source to hand-edit — this is the SAME URL
    // prompt the desktop selection toolbar and the `/` menu's Link item open
    // (`linkPrompt/`), reused rather than forked (M10). It handles both a
    // selection (edits the run's existing link, or wraps it in a new one) and
    // a plain caret (inserts the URL as its own label, selected) — see
    // `openLinkPrompt`'s header comment.
    link: () => {
      const editor = getEditor();
      if (editor) openLinkPrompt(editor);
    },
    'heading-1': block('heading-1'),
    'heading-2': block('heading-2'),
    'heading-3': block('heading-3'),
    paragraph: block('paragraph'),
    quote: block('quote'),
    // QA-009: one-way (see toolbar.ts's `code-block` item comment) — the same
    // command the `/` menu's Code block item runs (slash/exec.ts).
    'code-block': () => run(createCodeBlockCommand),
    'bullet-list': block('bullet'),
    'ordered-list': block('ordered'),
    'task-list': block('task'),
    indent: () => dispatch(changeBlockIndent(1)),
    outdent: () => dispatch(changeBlockIndent(-1)),
    // QA-003: prosemirror-history's own commands — never a hand-rolled stack.
    // `dispatch`, not `run`: these are plain ProseMirror Commands, not
    // Milkdown command-registry entries.
    undo: () => dispatch(undo),
    redo: () => dispatch(redo),
  };
}

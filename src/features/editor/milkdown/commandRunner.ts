import type { CmdKey, Editor } from '@milkdown/kit/core';
import type { Command } from '@milkdown/kit/prose/state';
import { callCommand } from '@milkdown/kit/utils';

import { editorView } from './caretContext';

/** Commands from either registry keep the editor focused after execution. */
export function createCommandRunner(getEditor: () => Editor | null) {
  return {
    run<T>(command: { key: CmdKey<T> }, payload?: T): void {
      const editor = getEditor();
      if (!editor) return;
      editor.action(callCommand(command.key, payload));
      editorView(editor)?.focus();
    },
    dispatch(command: Command): void {
      const view = editorView(getEditor());
      if (!view) return;
      command(view.state, view.dispatch.bind(view));
      view.focus();
    },
  };
}

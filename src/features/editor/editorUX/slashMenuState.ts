import { EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { EditorCommand } from './commands';

export interface SlashMenuState {
  open: boolean;
  from: number;
}

const STATE_CLOSED: SlashMenuState = { open: false, from: 0 };

export const openSlashMenuEffect = StateEffect.define<{ from: number }>();
export const closeSlashMenuEffect = StateEffect.define<void>();

export const slashMenuField = StateField.define<SlashMenuState>({
  create: () => STATE_CLOSED,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(closeSlashMenuEffect)) return STATE_CLOSED;
      if (effect.is(openSlashMenuEffect)) return { open: true, from: effect.value.from };
    }
    if (!value.open) return value;

    const from = transaction.changes.mapPos(value.from, -1);
    const selection = transaction.state.selection.main;
    if (!selection.empty || selection.from <= from || from >= transaction.state.doc.length) {
      return STATE_CLOSED;
    }
    if (transaction.state.sliceDoc(from, from + 1) !== '/') return STATE_CLOSED;
    if (selection.from > transaction.state.doc.lineAt(from).to) return STATE_CLOSED;

    return { open: true, from };
  },
});

export function getSlashQuery(state: EditorState): string {
  const menu = state.field(slashMenuField, false);
  if (!menu?.open) return '';
  return state.sliceDoc(menu.from + 1, state.selection.main.from);
}

function canOpenAt(state: EditorState, from: number): boolean {
  const line = state.doc.lineAt(from);
  return /^\s*$/.test(state.sliceDoc(line.from, from));
}

export const slashInputHandler = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '/' || from !== to || !canOpenAt(view.state, from)) return false;
  if (view.state.field(slashMenuField, false)?.open) return false;

  view.dispatch({
    changes: { from, to, insert: '/' },
    selection: EditorSelection.cursor(from + 1),
    effects: openSlashMenuEffect.of({ from }),
    userEvent: 'input.type',
  });
  return true;
});

export function commitSlashCommand(view: EditorView, command: EditorCommand): void {
  const menu = view.state.field(slashMenuField, false);
  if (!menu?.open) return;

  view.dispatch({
    changes: { from: menu.from, to: view.state.selection.main.from, insert: '' },
    selection: EditorSelection.cursor(menu.from),
    effects: closeSlashMenuEffect.of(),
    userEvent: 'delete',
  });
  command.run(view, menu.from);
}

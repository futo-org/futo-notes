import { EditorState, Prec } from '@codemirror/state';
import type { Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { slashMenuPlugin } from './slashMenuRenderer';
import {
  closeSlashMenuEffect,
  commitSlashCommand,
  slashInputHandler,
  slashMenuField,
} from './slashMenuState';

export { computeMenuPlacement } from './slashMenuRenderer';
export {
  closeSlashMenuEffect,
  getSlashQuery,
  openSlashMenuEffect,
  slashInputHandler,
  slashMenuField,
  type SlashMenuState,
} from './slashMenuState';

function isOpen(view: EditorView): boolean {
  return view.state.field(slashMenuField, false)?.open === true;
}

function moveSelection(view: EditorView, delta: number): boolean {
  if (!isOpen(view)) return false;
  return view.plugin(slashMenuPlugin)?.move(delta) ?? false;
}

function commitSelection(view: EditorView): boolean {
  if (!isOpen(view)) return false;
  const command = view.plugin(slashMenuPlugin)?.getSelected();
  if (!command) return false;
  commitSlashCommand(view, command);
  return true;
}

function closeMenu(view: EditorView): boolean {
  if (!isOpen(view)) return false;
  view.dispatch({ effects: closeSlashMenuEffect.of() });
  return true;
}

const slashNavigationKeymap = Prec.highest(
  keymap.of([
    { key: 'ArrowDown', run: (view) => moveSelection(view, 1) },
    { key: 'ArrowUp', run: (view) => moveSelection(view, -1) },
    { key: 'Enter', run: commitSelection },
    { key: 'Tab', run: commitSelection },
    { key: 'Escape', run: closeMenu },
  ]),
);

const slashClosingFilter = EditorState.transactionFilter.of((transaction: Transaction) => {
  const menu = transaction.startState.field(slashMenuField, false);
  if (!menu?.open || !transaction.docChanged) return transaction;
  const from = transaction.changes.mapPos(menu.from, -1);
  if (from < 0 || from >= transaction.newDoc.length) {
    return [transaction, { effects: closeSlashMenuEffect.of() }];
  }
  if (transaction.newDoc.sliceString(from, from + 1) !== '/') {
    return [transaction, { effects: closeSlashMenuEffect.of() }];
  }
  return transaction;
});

export const slashMenu = [
  slashMenuField,
  slashInputHandler,
  slashMenuPlugin,
  slashNavigationKeymap,
  slashClosingFilter,
];

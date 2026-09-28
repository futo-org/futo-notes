import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';

import { isReportableDocumentChange } from './documentChanges';

/**
 * Whether a transaction may apply while the note is read-only. `editable: false`
 * stops typed characters but not keymap commands (Enter, Backspace, Mod-B, list
 * indent) or a dropped image, so the lock is enforced where every edit lands.
 * The editor's own loads (`addToHistory: false`) still apply, so a locked vault's
 * notes can be opened and read.
 */
export function allowedWhileReadOnly(transaction: Transaction, readOnly: boolean): boolean {
  return !readOnly || !isReportableDocumentChange(transaction);
}

export function readOnlyGuard(isReadOnly: () => boolean): MilkdownPlugin {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey('FUTO_READ_ONLY_GUARD'),
        filterTransaction: (transaction) => allowedWhileReadOnly(transaction, isReadOnly()),
      }),
  );
}

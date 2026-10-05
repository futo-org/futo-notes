/**
 * "The document changed" — the editor's own signal, not the listener plugin's.
 *
 * `@milkdown/plugin-listener` already reports changes, and the component used
 * to take them straight from its `markdownUpdated` callback. That callback is
 * not a document-change signal, though: the plugin keeps a `prevDoc` baseline
 * and stays SILENT whenever the debounced document is `.eq()` to it. Its
 * baseline is only ever advanced by its own trailing callback, and the host's
 * load is one more transaction in that same 200 ms window — so a note opened
 * and edited inside one window leaves the baseline at the PRISTINE EMPTY
 * document the editor was created with.
 *
 * A user who then clears the note lands on exactly that document. The plugin
 * compares it to its stale baseline, calls it unchanged, and the deletion is
 * never reported: no `change` message, no save scheduled, and — since
 * `noteSessionChanges.editorLostTheNote` reads an unannounced empty editor as a
 * blank editor rather than a deletion — nothing writes it at close either. The
 * user's note comes back the next time they open it.
 * → docs/spec/editor.md "Saving & rename"
 *
 * So the component watches transactions itself and serializes the LIVE document
 * when they settle. There is no baseline to go stale, and the answer is never a
 * snapshot of the document as it stood one transaction ago.
 */
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';
import { noteEditIntent } from '$shared/lifecycle/editIntent';

/**
 * How long the document must sit still before it is reported.
 *
 * The same 200 ms `@milkdown/plugin-listener` used, so the cadence every
 * existing test and both native shells were tuned against is unchanged. It is a
 * debounce, not a delay: typing restarts it, so a burst costs one serialization.
 */
export const DOCUMENT_CHANGE_DEBOUNCE_MS = 200;

/**
 * The longest an edit waits to be reported while the document never sits
 * still. Typing faster than the debounce used to be reported only when it
 * paused, and a crash mid-burst lost the whole burst (RC-26). One report per
 * this interval is one serialization of what changed, not of the note.
 */
export const DOCUMENT_CHANGE_MAX_WAIT_MS = 1_500;

function isHousekeeping(transaction: Transaction): boolean {
  return transaction.getMeta('addToHistory') === false;
}

/**
 * Whether a transaction is one the host should hear about — the editor's one
 * definition of a user edit.
 *
 * `addToHistory: false` is the editor's own housekeeping — above all the
 * streamed chunk appends of a progressive open (progressiveLoad.ts), which are
 * a PREFIX of the note and must never start a report. The listener plugin
 * skipped exactly these, and the save lock in MilkdownEditor is the second half
 * of the same guarantee. A transaction another plugin appended in reaction to
 * one of them (`trailing` re-adding its empty paragraph after a load) is
 * housekeeping too, by the rule prosemirror-history itself applies.
 */
export function isReportableDocumentChange(transaction: Transaction): boolean {
  if (!transaction.docChanged || isHousekeeping(transaction)) return false;
  const root = transaction.getMeta('appendedTransaction') as Transaction | undefined;
  return !(root && isHousekeeping(root));
}

/**
 * A ProseMirror plugin that calls `onDocumentChanged` once per dispatch that
 * altered the document. It reads nothing and returns no transaction of its own;
 * `appendTransaction` is simply the hook that sees every dispatch exactly once.
 */
export function createDocumentChangePlugin(onDocumentChanged: () => void): Plugin {
  return new Plugin({
    key: new PluginKey('FUTO_DOCUMENT_CHANGES'),
    appendTransaction: (transactions) => {
      if (transactions.some(isReportableDocumentChange)) {
        // Synchronously, at dispatch: before the work the edit sets off (re-render,
        // layout) and before the debounce the host hears about it through. Covers every
        // edit source, including keymap commands and clicks that raise no input event.
        noteEditIntent();
        onDocumentChanged();
      }
      return null;
    },
  });
}

/**
 * The Milkdown wrapper. Built per editor instance rather than once at module
 * scope, because the callback belongs to one mounted component.
 */
export function documentChanges(onDocumentChanged: () => void): MilkdownPlugin {
  return $prose(() => createDocumentChangePlugin(onDocumentChanged));
}

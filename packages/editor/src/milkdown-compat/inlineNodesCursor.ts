/*
 * The caret between two non-text inline nodes, without the stuck composition.
 *
 * `@milkdown/preset-commonmark`'s `inlineNodesCursorPlugin` gives a caret that
 * sits between two inline atoms (two wikilink chips, an image and a chip, a
 * hard break and a chip) somewhere to live: it draws an editable widget on each
 * side of the caret, takes a plain keystroke there over itself (`beforeinput`),
 * and takes an IME composition over too — the browser writes the composed text
 * into the widget, which ProseMirror ignores, so the plugin reads the committed
 * text off `compositionend` and inserts it as a transaction from the next frame.
 *
 * That `compositionend` handler returned `true` ("handled"), and a custom
 * `handleDOMEvents` handler that claims an event keeps ProseMirror's OWN
 * handler from running. ProseMirror's is what ends the composition
 * (`view.composing = false`), so after any IME commit in that spot the flag
 * stayed set — for good on desktop and iOS, where prosemirror-view's 5 s
 * composition timeout is Android-only. A stuck `view.composing` switches off
 * markdown input rules (`- ` stays literal), and the host's `isComposing()`
 * reads the same flag: sync keeps deferring external changes and the selection
 * toolbar stays hidden, until the next composition happens to end (FB-19,
 * L6f-2).
 *
 * This is the upstream plugin with four changes, everything else verbatim:
 *  1. `compositionend` returns `false`, so ProseMirror ends the composition.
 *  2. The re-insert no longer asks "is the caret STILL between two inline
 *     nodes?" at the next frame. A character typed in the gap — the keyboard
 *     committing a word and its trailing space in one batch — had already moved
 *     the caret, so the check failed and the committed word was dropped
 *     (measured: `hello` + `X` saved as just `X`). It asks instead whether
 *     anything BEFORE the caret changed; the typed character lands at the same
 *     position, so the word goes in front of it, in typed order.
 *  3. `compositionend` re-inserts only while the caret is still in the gap.
 *     Dropping the old next-frame check made `lock` ("this composition started
 *     in the gap") outlive the gap: a candidate pick that commits a prefix and
 *     keeps composing, a deleted chip or a moved selection all continue as an
 *     ordinary composition ProseMirror reads itself, and its commit was then
 *     inserted a second time (R10-FB19-1).
 *  4. `compositionstart` deletes a selection that covers a chip (a NodeSelection,
 *     or a range across one) before ProseMirror's own handler sees it, so an IME
 *     composed over a selected chip replaces it instead of losing the commit
 *     and sticking `view.composing` (RC-97; not the gap, but the same symptom).
 *
 * `milkdown-compat.canary.spec.ts`-style canary: the `baseline` half of
 * `tests/editor-embed-milkdown-compat.spec.ts` shows the upstream plugin still
 * leaves `view.composing` set; when upstream fixes it, delete this file.
 */
import { NodeSelection, Plugin, PluginKey, type Selection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

/** A non-empty selection that takes a chip, an image or a hard break with it. */
function coversInlineAtom(selection: Selection): boolean {
  if (selection.empty) return false;
  if (selection instanceof NodeSelection) return selection.node.isInline && !selection.node.isText;
  let found = false;
  selection.$from.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.isInline && !node.isText) found = true;
    return !found;
  });
  return found;
}

export const inlineNodesCursorPlugin = $prose(() => {
  let lock = false;
  /* Set while `compositionstart` deletes a selected chip (RC-97): the gap that
   * leaves is where a composition is ALREADY starting, so its widgets must be
   * editable now, not on the next tick. */
  let widgetsAtOnce = false;
  const plugin: Plugin<boolean> = new Plugin<boolean>({
    key: new PluginKey('MILKDOWN_INLINE_NODES_CURSOR'),
    state: {
      init() {
        return false;
      },
      apply(tr) {
        if (!tr.selection.empty) return false;
        const pos = tr.selection.$from;
        const left = pos.nodeBefore;
        const right = pos.nodeAfter;
        return !!(
          left &&
          right &&
          left.isInline &&
          !left.isText &&
          right.isInline &&
          !right.isText
        );
      },
    },
    props: {
      handleDOMEvents: {
        compositionend: (view, e) => {
          if (!lock) return false;
          lock = false;
          /* `lock` only says the composition STARTED in the gap. If the caret has
           * left it since — the previous commit's re-insert ran, a chip was
           * deleted, the selection moved — the composed text went into ordinary
           * text, which ProseMirror read itself; inserting it again would
           * duplicate it. Upstream never had this hole: it only re-inserted while
           * the caret was still in the gap. */
          if (!plugin.getState(view.state)) return false;
          const data = (e as CompositionEvent).data || '';
          const docAtEnd = view.state.doc;
          const from = view.state.selection.from;
          requestAnimationFrame(() => {
            if (view.isDestroyed || !data) return;
            const changedAt = docAtEnd.content.findDiffStart(view.state.doc.content);
            if (changedAt !== null && changedAt < from) return;
            view.dispatch(view.state.tr.insertText(data, from));
          });
          // Not handled: ProseMirror's own `compositionend` has to run.
          return false;
        },
        compositionstart: (view) => {
          /* A SELECTED chip (a NodeSelection: tapped, or reached with an arrow key),
           * or a range that spans one, composed over. ProseMirror's own
           * `compositionstart` sees a DOM selection that differs from its state's
           * and re-dispatches it under the live composition, and re-rendering the
           * selection makes Chromium drop the composition with no `compositionend`:
           * the committed text is lost and `view.composing` stays set (RC-97). Blink
           * deletes the selection itself right after this event, so doing it here
           * first leaves an empty caret and an ordinary composition, the way a
           * range of plain text already behaves. Runs before the gap check below:
           * deleting a chip can leave the caret between two others. */
          if (coversInlineAtom(view.state.selection)) {
            widgetsAtOnce = true;
            try {
              view.dispatch(view.state.tr.deleteSelection());
            } finally {
              widgetsAtOnce = false;
            }
          }
          if (plugin.getState(view.state)) lock = true;
          return false;
        },
        beforeinput: (view, e) => {
          if (plugin.getState(view.state) && e instanceof InputEvent && e.data && !lock) {
            e.preventDefault();
            view.dispatch(view.state.tr.insertText(e.data, view.state.selection.from));
            return true;
          }
          return false;
        },
      },
      decorations(state) {
        if (!plugin.getState(state)) return DecorationSet.empty;
        const position = state.selection.$from.pos;
        const left = document.createElement('span');
        const right = document.createElement('span');
        const makeEditable = () => {
          left.contentEditable = 'true';
          right.contentEditable = 'true';
        };
        if (widgetsAtOnce) makeEditable();
        else setTimeout(makeEditable);
        return DecorationSet.create(state.doc, [
          Decoration.widget(position, left, { side: -1 }),
          Decoration.widget(position, right),
        ]);
      },
    },
  });
  return plugin;
});

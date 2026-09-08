/** Vault suggestions use the same Milkdown positioning provider as the slash menu. */
import { SlashProvider } from '@milkdown/kit/plugin/slash';
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorState } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { getAllNotes, getWikilinkIndex } from '$features/notes/notes.svelte';
import {
  wikilinkCandidates,
  wikilinkQueryIn,
  type WikilinkCandidate,
} from '../../wikilinkSuggestions';
import { createWikilink, isInCode } from './node';

interface SuggestionState {
  /** Document position of the `[` that opened the query. */
  from: number;
  candidates: WikilinkCandidate[];
  selected: number;
}

interface PluginState {
  open: SuggestionState | null;
  /**
   * The `[[` run the user dismissed with Escape. Kept so the popup does not
   * reopen on the very next keystroke — someone who pressed Escape wants the
   * literal text — while a NEW `[[` elsewhere still offers completions.
   */
  dismissedFrom: number | null;
}

const CLOSED: PluginState = { open: null, dismissedFrom: null };

const wikilinkSuggestKey = new PluginKey<PluginState>('futo-wikilink-suggest');

/** An open `[[` run at the caret, and what it currently offers. */
interface OpenRun {
  /** Document position of the `[` that opened it. */
  from: number;
  candidates: WikilinkCandidate[];
}

/**
 * Reads the open `[[` run at the caret. Returns null whenever there is none:
 * a non-empty selection, a code block or code span (docs/spec/editor.md —
 * "Wikilinks and tags inside inline code or fenced blocks are NOT decorated and
 * NOT extracted", so the popup must not offer to write one there either), or no
 * `[[` before the caret.
 *
 * An open run with NO matching notes still comes back, with an empty candidate
 * list: the popup stays hidden either way, but the caller needs the run's
 * position to remember an Escape across a query that matches nothing.
 */
function readOpenRun(state: EditorState): OpenRun | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $head = selection.$head;
  if (isInCode($head, state.storedMarks)) return null;

  /* Cheap reject before the string build. `apply` runs on EVERY transaction,
   * i.e. every keystroke (M5), and the whole-paragraph `textBetween` below
   * allocates; a paragraph with no `[` in it cannot hold an open run. */
  if (!$head.parent.textContent.includes('[')) return null;

  const textBefore = $head.parent.textBetween(
    0,
    $head.parentOffset,
    undefined,
    // A leaf (an existing wikilink chip, an image) must occupy a character so
    // the offset arithmetic below still lands on the right document position.
    '￼',
  );
  const found = wikilinkQueryIn(textBefore);
  if (!found) return null;

  return {
    from: $head.pos - (textBefore.length - found.from),
    candidates: wikilinkCandidates(found.query, getAllNotes(), getWikilinkIndex()),
  };
}

/**
 * Replaces the whole `[[query` run with the link and puts the caret AFTER it.
 *
 * The caret placement is explicit, not left to selection mapping: "typing
 * continues past the link, not inside it" is a spec line with its own
 * regression history (docs/spec/editor.md — "a bare change dispatch left the
 * caret stranded after `[[`").
 */
function commit(view: ProseView, state: SuggestionState, candidate: WikilinkCandidate): void {
  const link = createWikilink(view.state.schema, candidate.id);
  const tr = view.state.tr.replaceWith(state.from, view.state.selection.head, link);
  tr.setSelection(TextSelection.near(tr.doc.resolve(state.from + link.nodeSize)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

class SuggestionPopup {
  readonly dom: HTMLDivElement;
  private readonly list: HTMLUListElement;
  private readonly provider: SlashProvider;
  private visible = false;

  constructor(private readonly onPick: (index: number) => void) {
    this.dom = document.createElement('div');
    this.dom.className = 'futo-wikilink-suggest';
    this.dom.setAttribute('role', 'listbox');
    this.list = document.createElement('ul');
    this.dom.appendChild(this.list);
    this.dom.dataset.show = 'false';
    this.provider = new SlashProvider({
      content: this.dom,
      root: document.body,
      floatingUIOptions: { strategy: 'fixed' },
      offset: 4,
      debounce: 0,
      shouldShow: () => this.visible,
    });
    // pointerdown, not click: a click would land after the editor had already
    // blurred, and on iOS WebKit a prevented mousedown cancels the click
    // entirely (the same trap the wikilink tap path documents).
    this.dom.addEventListener('pointerdown', (event) => {
      const row = (event.target as HTMLElement | null)?.closest('li');
      if (!row?.parentElement) return;
      event.preventDefault();
      this.onPick(Array.prototype.indexOf.call(row.parentElement.children, row));
    });
  }

  render(state: SuggestionState, view: ProseView): void {
    // Chromium 80 has no Element.replaceChildren.
    this.list.textContent = '';
    state.candidates.forEach((candidate, index) => {
      const row = document.createElement('li');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === state.selected));
      const label = document.createElement('span');
      label.className = 'futo-wikilink-suggest-label';
      label.textContent = candidate.label;
      row.appendChild(label);
      if (candidate.detail) {
        const detail = document.createElement('span');
        detail.className = 'futo-wikilink-suggest-detail';
        detail.textContent = candidate.detail;
        row.appendChild(detail);
      }
      this.list.appendChild(row);
    });
    this.visible = true;
    this.provider.update(view);
    this.list.children[state.selected]?.scrollIntoView({ block: 'nearest' });
  }

  hide(): void {
    this.visible = false;
    this.provider.hide();
  }

  destroy(): void {
    this.provider.destroy();
    this.dom.remove();
  }
}

export const wikilinkAutocomplete = $prose(() => {
  return new Plugin<PluginState>({
    key: wikilinkSuggestKey,
    state: {
      init: () => CLOSED,
      apply(tr, previous, _old, next) {
        const meta = tr.getMeta(wikilinkSuggestKey) as 'dismiss' | number | undefined;
        const run = readOpenRun(next);
        if (!run) return CLOSED;
        if (meta === 'dismiss') return { open: null, dismissedFrom: run.from };
        /* An Escape is remembered for as long as the SAME `[[` run is being
         * typed — including while the query matches nothing, which is why the
         * run is read before the candidate list is consulted. */
        if (previous.dismissedFrom === run.from) return { open: null, dismissedFrom: run.from };
        if (run.candidates.length === 0) return CLOSED;
        const fresh: SuggestionState = { ...run, selected: 0 };
        const open = previous.open;
        if (typeof meta === 'number' && open) {
          const count = run.candidates.length;
          const selected = (((open.selected + meta) % count) + count) % count;
          return { open: { ...fresh, selected }, dismissedFrom: null };
        }
        // Keep the highlighted row while only the selection moved inside the
        // same query; a changed query starts again at the top.
        if (open && open.from === run.from && !tr.docChanged) {
          return {
            open: { ...fresh, selected: Math.min(open.selected, run.candidates.length - 1) },
            dismissedFrom: null,
          };
        }
        return { open: fresh, dismissedFrom: null };
      },
    },
    props: {
      handleKeyDown(view, event) {
        const state = wikilinkSuggestKey.getState(view.state)?.open;
        if (!state) return false;
        switch (event.key) {
          case 'ArrowDown':
            view.dispatch(view.state.tr.setMeta(wikilinkSuggestKey, 1));
            return true;
          case 'ArrowUp':
            view.dispatch(view.state.tr.setMeta(wikilinkSuggestKey, -1));
            return true;
          case 'Enter':
          case 'Tab':
            commit(view, state, state.candidates[state.selected]);
            return true;
          case 'Escape':
            view.dispatch(view.state.tr.setMeta(wikilinkSuggestKey, 'dismiss'));
            return true;
          default:
            return false;
        }
      },
    },
    view(editorView) {
      const popup = new SuggestionPopup((index) => {
        const state = wikilinkSuggestKey.getState(editorView.state)?.open;
        if (state) commit(editorView, state, state.candidates[index]);
      });
      return {
        update(view) {
          const state = wikilinkSuggestKey.getState(view.state)?.open;
          if (state) popup.render(state, view);
          else popup.hide();
        },
        destroy() {
          popup.destroy();
        },
      };
    },
  });
});

import { autocompletion, startCompletion } from '@codemirror/autocomplete';
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { getAllNotes } from '$lib/notes.svelte';
import { searchNotes } from '$lib/searchIndex';

function makeApply(title: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    // `from` is after [[, `to` is cursor position — replace with title]]
    view.dispatch({
      changes: { from, to, insert: `${title}]]` }
    });
  };
}

function wikilinkCompletions(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\[\[[^\]]*$/);
  if (!match) return null;

  const query = match.text.slice(2); // text after [[

  let options: Completion[];

  if (query.trim()) {
    // Ranked search via MiniSearch, fallback to substring filter
    const hits = searchNotes(query);
    if (hits.length > 0) {
      options = hits.slice(0, 20).map(hit => ({
        label: hit.noteId,
        apply: makeApply(hit.noteId)
      }));
    } else {
      const lowerQ = query.toLowerCase();
      options = getAllNotes()
        .filter(n => n.title.toLowerCase().includes(lowerQ))
        .slice(0, 20)
        .map(n => ({
          label: n.title,
          apply: makeApply(n.title)
        }));
    }
  } else {
    // No query — show 20 most recent notes
    options = getAllNotes()
      .sort((a, b) => b.modificationTime - a.modificationTime)
      .slice(0, 20)
      .map(n => ({
        label: n.title,
        apply: makeApply(n.title)
      }));
  }

  if (options.length === 0) return null;

  return {
    // `from` must be after [[ so CM filters against the typed query, not [[
    from: match.from + 2,
    options,
    validFor: /^[^\]]*$/
  };
}

/**
 * Input handler that explicitly triggers autocomplete when user types `[[`.
 * CM's `activateOnTyping` may not reliably re-trigger for non-word characters,
 * so we detect the `[[` pattern on input and call `startCompletion` directly.
 */
const wikilinkInputHandler = EditorView.inputHandler.of(
  (view, from, _to, text) => {
    if (text === '[') {
      const before = from > 0 ? view.state.doc.sliceString(from - 1, from) : '';
      if (before === '[') {
        // Let the `[` be inserted first, then trigger completion
        setTimeout(() => startCompletion(view), 0);
      }
    }
    return false; // Don't consume the input — let CM handle it normally
  }
);

export function wikilinkAutocomplete() {
  return [
    autocompletion({
      override: [wikilinkCompletions],
      activateOnTyping: true,
      icons: false,
      closeOnBlur: true,
      tooltipClass: () => 'cm-wikilink-tooltip'
    }),
    wikilinkInputHandler
  ];
}

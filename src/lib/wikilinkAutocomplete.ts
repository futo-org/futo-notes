import { autocompletion, startCompletion } from '@codemirror/autocomplete';
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { getAllNotes } from '$lib/notes.svelte';
import { searchNotes } from '$features/search/searchIndex';
import { shortestUniqueSuffix } from '$lib/wikilinks';

function makeApply(fullPath: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    // Insert the full path so the on-disk wikilink is unambiguous,
    // even when the displayed/dropdown text is just the shortest
    // unique suffix.
    view.dispatch({
      changes: { from, to, insert: `${fullPath}]]` }
    });
  };
}

function wikilinkCompletions(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\[\[[^\]]*$/);
  if (!match) return null;

  const query = match.text.slice(2); // text after [[
  const allNotes = getAllNotes();
  const allIds = allNotes.map((n) => n.id);

  /** Build a Completion entry: label is the shortest unique suffix
   *  (what the user sees in the dropdown), but `apply` inserts the full
   *  path so the on-disk wikilink resolves unambiguously. */
  const buildCompletion = (id: string): Completion => {
    const display = shortestUniqueSuffix(id, allIds);
    // `detail` shows the full path next to the label so collisions are
    // resolvable visually when two suffixes are identical.
    return {
      label: display,
      detail: display === id ? undefined : id,
      apply: makeApply(id),
    };
  };

  let options: Completion[];

  if (query.trim()) {
    // Ranked search via MiniSearch, fallback to substring filter
    const hits = searchNotes(query);
    if (hits.length > 0) {
      options = hits.slice(0, 20).map((hit) => buildCompletion(hit.noteId));
    } else {
      const lowerQ = query.toLowerCase();
      options = allNotes
        .filter((n) => n.id.toLowerCase().includes(lowerQ))
        .slice(0, 20)
        .map((n) => buildCompletion(n.id));
    }
  } else {
    // No query — show 20 most recent notes
    options = allNotes
      .slice()
      .sort((a, b) => b.modificationTime - a.modificationTime)
      .slice(0, 20)
      .map((n) => buildCompletion(n.id));
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

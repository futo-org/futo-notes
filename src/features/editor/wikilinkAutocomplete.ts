import { autocompletion, startCompletion } from '@codemirror/autocomplete';
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { getAllNotes } from '$features/notes/notes.svelte';
import { shortestUniqueSuffix } from '$shared/note/wikilinks';

export function makeApply(fullPath: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const insert = `${fullPath}]]`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      userEvent: 'input.complete',
    });
  };
}

function wikilinkCompletions(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\[\[[^\]]*$/);
  if (!match) return null;

  const query = match.text.slice(2); // text after [[
  const allNotes = getAllNotes();
  const allIds = allNotes.map((n) => n.id);

  const buildCompletion = (id: string): Completion => {
    const display = shortestUniqueSuffix(id, allIds);
    return {
      label: display,
      detail: display === id ? undefined : id,
      apply: makeApply(id),
    };
  };

  let options: Completion[];

  if (query.trim()) {
    const lowerQuery = query.toLocaleLowerCase();
    options = allNotes
      .filter((note) => note.id.toLocaleLowerCase().includes(lowerQuery))
      .slice(0, 20)
      .map((note) => buildCompletion(note.id));
  } else {
    options = allNotes.slice(0, 20).map((n) => buildCompletion(n.id));
  }

  if (options.length === 0) return null;

  return {
    from: match.from + 2,
    options,
    validFor: /^[^\]]*$/,
  };
}

const wikilinkInputHandler = EditorView.inputHandler.of((view, from, _to, text) => {
  if (text === '[') {
    const before = from > 0 ? view.state.doc.sliceString(from - 1, from) : '';
    if (before === '[') {
      setTimeout(() => startCompletion(view), 0);
    }
  }
  return false; // Don't consume the input — let CM handle it normally
});

export function wikilinkAutocomplete() {
  return [
    autocompletion({
      override: [wikilinkCompletions],
      activateOnTyping: true,
      icons: false,
      closeOnBlur: true,
      tooltipClass: () => 'cm-wikilink-tooltip',
    }),
    wikilinkInputHandler,
  ];
}

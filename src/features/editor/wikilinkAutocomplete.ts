import { autocompletion, startCompletion } from '@codemirror/autocomplete';
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { getAllNotes, getWikilinkIndex } from '$features/notes/notes.svelte';
import {
  OPEN_WIKILINK_RE,
  wikilinkCandidates,
  type WikilinkCandidate,
} from './wikilinkSuggestions';

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

/** A shared candidate as CodeMirror wants it; only `apply` is engine-specific. */
function toCompletion(candidate: WikilinkCandidate): Completion {
  return { label: candidate.label, detail: candidate.detail, apply: makeApply(candidate.id) };
}

function wikilinkCompletions(context: CompletionContext): CompletionResult | null {
  // The SAME open-link pattern the Milkdown plugin uses — matchBefore anchors
  // it at the caret for us.
  const match = context.matchBefore(OPEN_WIKILINK_RE);
  if (!match) return null;

  const options = wikilinkCandidates(
    match.text.slice(2), // text after [[
    getAllNotes(),
    getWikilinkIndex(),
  ).map(toCompletion);
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

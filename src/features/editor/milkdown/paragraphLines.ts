/*
 * Enter is a newline (docs/spec/editor.md "Paragraphs and lines", #263).
 *
 * A top-level paragraph is a run of typed lines. Enter inside one inserts the
 * inline line break the parser itself makes for a single newline in the file
 * (`hardbreak` with `isInline: true`, written back as exactly one `\n`), so the
 * file holds the newline that was typed and nothing else. Where that newline
 * would leave a blank line — right after another newline, or at the start of
 * the paragraph — the file can only spell it as a paragraph break, so the
 * paragraph is split there instead: two Enters end a paragraph, and a third
 * leaves an empty paragraph, which the file spells as one extra blank line.
 * Backspace at the start of a paragraph that follows a paragraph is the
 * inverse: it removes one newline, so the two become two lines of one
 * paragraph again (Delete at the end of the first, likewise).
 *
 * Lists, headings, quotes, code and table cells keep their own Enter; only a
 * paragraph that is a direct child of the document is a run of lines here.
 *
 * Because a typed line is no longer its own paragraph, everything that used to
 * act on "the paragraph the caret is in" — a block format from a toolbar or the
 * `/` menu, a markdown shortcut like `- ` typed at the start of a line — would
 * now take every line of the paragraph with it. `isolateSelectedLines` gives
 * the lines such a command touches their own paragraph first, so it lands on
 * exactly the lines it did when each line was a paragraph.
 *
 * The inline break used to render as a space (`<span> </span>`, CommonMark's
 * HTML reading of a soft line break). `softBreakView` renders it as the line
 * break it now is.
 */
import { nodesCtx } from '@milkdown/kit/core';
import { hardbreakAttr } from '@milkdown/kit/preset/commonmark';
import type { Mark, Node as ProseNode, ResolvedPos } from '@milkdown/kit/prose/model';
import {
  EditorState,
  Selection,
  TextSelection,
  type Command,
  type Transaction,
} from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { $node } from '@milkdown/kit/utils';

/**
 * A line break inside a paragraph. Enter only ever makes the inline kind (a
 * single newline in the file); a `\` or two-space break an older file holds is
 * a line boundary all the same.
 */
function isLineBreak(node: ProseNode | null | undefined): boolean {
  return node?.type.name === 'hardbreak';
}

/** Whether `$pos` is directly inside a top-level paragraph — the only block that holds typed lines. */
function inLinedParagraph($pos: ResolvedPos): boolean {
  return $pos.depth === 1 && $pos.parent.type.name === 'paragraph';
}

/**
 * The inline line break, carrying `marks` — minus any code mark: a newline
 * inside a code span reads back as a space, so a line break always ends one.
 */
function softBreak(state: EditorState, marks: readonly Mark[]): ProseNode | null {
  const kept = marks.filter((mark) => mark.type.spec.code !== true);
  return state.schema.nodes.hardbreak?.create({ isInline: true }, null, kept) ?? null;
}

/**
 * Enter (and Shift+Enter, which is the same key here) in a top-level paragraph.
 * Declines anywhere else, leaving the key to the list, heading, quote, code
 * and table bindings.
 */
export const enterInParagraph: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return false;
  if (!inLinedParagraph(selection.$from) || !selection.$from.sameParent(selection.$to)) {
    return false;
  }
  if (!dispatch) return true;

  const tr = state.tr;
  if (!selection.empty) tr.deleteSelection();
  const $at = tr.selection.$from;
  const marks = tr.storedMarks ?? $at.marks();

  if ($at.parentOffset === 0 || isLineBreak($at.nodeBefore)) {
    // A newline here would open a blank line, which only a paragraph break
    // can spell: drop the newline before the caret (if any) and split.
    const at = $at.parentOffset === 0 ? $at.pos : $at.pos - 1;
    if (at !== $at.pos) tr.delete(at, $at.pos);
    tr.split(at);
    tr.setSelection(TextSelection.create(tr.doc, at + 2));
    if (marks.length > 0) tr.ensureMarks(marks);
  } else {
    const lineBreak = softBreak(state, marks);
    if (!lineBreak) return false;
    tr.insert($at.pos, lineBreak);
    tr.setSelection(TextSelection.create(tr.doc, $at.pos + 1));
  }
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Whether the note's last written block is a paragraph ending in a line break
 * — an empty last line the file cannot hold (trailing whitespace is not
 * content), so the document serializes exactly like one without it. Trailing
 * empty paragraphs are skipped: those are not written either.
 */
export function endsWithUnwrittenLine(doc: ProseNode): boolean {
  for (let index = doc.childCount - 1; index >= 0; index -= 1) {
    const block = doc.child(index);
    if (block.type.name !== 'paragraph') return false;
    if (block.content.size > 0) return isLineBreak(block.lastChild);
  }
  return false;
}

/**
 * Join the top-level paragraph ending at `boundary` with the one starting there
 * as two lines of one paragraph, if both hold text. `caretAfter` puts the caret
 * after the new line break (Backspace) or before it (Delete). The break carries
 * no marks, so the file loses exactly one newline: `**a**\n\n**b**` becomes
 * `**a**\n**b**`, not a re-spelled `**a\nb**`.
 */
function joinAsLines(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  boundary: number,
  caretAfter: boolean,
): boolean {
  const $boundary = state.doc.resolve(boundary);
  if ($boundary.depth !== 0) return false;
  const before = $boundary.nodeBefore;
  const after = $boundary.nodeAfter;
  if (before?.type.name !== 'paragraph' || after?.type.name !== 'paragraph') return false;
  if (before.content.size === 0 || after.content.size === 0) return false;
  const lineBreak = softBreak(state, []);
  if (!lineBreak) return false;
  if (!dispatch) return true;
  const tr = state.tr.join(boundary);
  const at = boundary - 1;
  tr.insert(at, lineBreak);
  tr.setSelection(TextSelection.create(tr.doc, caretAfter ? at + 1 : at));
  dispatch(tr.scrollIntoView());
  return true;
}

/** Backspace at the start of a paragraph that follows a paragraph: remove one newline, not two. */
export const joinBackwardAsLine: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const $at = selection.$from;
  if (!inLinedParagraph($at) || $at.parentOffset !== 0) return false;
  return joinAsLines(state, dispatch, $at.before(), true);
};

/** Delete at the end of a paragraph that precedes a paragraph: the same, forwards. */
export const joinForwardAsLine: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const $at = selection.$from;
  if (!inLinedParagraph($at) || $at.parentOffset !== $at.parent.content.size) return false;
  return joinAsLines(state, dispatch, $at.after(), false);
};

/**
 * The line breaks to cut so the lines `[$from, $to]` touches stand alone: the
 * break that opens the first touched line, every break inside the range, and
 * the break that closes the last one. Empty when the range is not in one
 * top-level paragraph, or the paragraph is a single line.
 */
function cutsFor($from: ResolvedPos, $to: ResolvedPos): number[] {
  if (!inLinedParagraph($from) || !$from.sameParent($to)) return [];
  const start = $from.start();
  const breaks: number[] = [];
  $from.parent.forEach((child, offset) => {
    if (isLineBreak(child)) breaks.push(start + offset);
  });
  const opening = breaks.filter((at) => at + 1 <= $from.pos).pop();
  const closing = breaks.find((at) => at >= $to.pos);
  return breaks.filter(
    (at) => (opening === undefined || at >= opening) && (closing === undefined || at <= closing),
  );
}

/** Replace each cut line break with a paragraph boundary, last first so earlier positions hold. */
function cutLines(tr: Transaction, cuts: readonly number[]): void {
  for (const at of [...cuts].reverse()) {
    tr.delete(at, at + 1);
    tr.split(at);
  }
}

/**
 * Where `pos` lands once `cuts` are made. A position right before a cut is the
 * END of its line and stays there; the default mapping would carry it past the
 * new paragraph boundary into the next line.
 */
function mapAcrossCuts(tr: Transaction, cuts: readonly number[], pos: number): number {
  return tr.mapping.map(pos, cuts.includes(pos) ? -1 : 1);
}

/**
 * Give the lines the selection touches a paragraph each, so a block command run
 * next lands on those lines rather than on every line of the paragraph.
 * Declines when there is nothing to cut.
 */
export const isolateSelectedLines: Command = (state, dispatch) => {
  const cuts = cutsFor(state.selection.$from, state.selection.$to);
  if (cuts.length === 0) return false;
  if (!dispatch) return true;
  const tr = state.tr;
  cutLines(tr, cuts);
  const { anchor, head } = state.selection;
  tr.setSelection(
    TextSelection.create(tr.doc, mapAcrossCuts(tr, cuts, anchor), mapAcrossCuts(tr, cuts, head)),
  );
  dispatch(tr);
  return true;
};

/**
 * `command`, run on the selected lines only (`isolateSelectedLines`), as ONE
 * transaction. When `command` declines, nothing is dispatched — the cut is not
 * left behind on its own.
 *
 * The middle state is built with `EditorState.create`, never `apply`, for the
 * reason `commandRunner.ts` gives: `apply` runs every plugin's
 * `appendTransaction`, whose steps would then be missing from the combined
 * transaction.
 */
export function onSelectedLines(command: Command): Command {
  return (state, dispatch, view) => {
    let cut: Transaction | null = null;
    isolateSelectedLines(state, (tr) => {
      cut = tr;
    });
    if (cut === null) return command(state, dispatch, view);
    const isolated: Transaction = cut;
    const middle = EditorState.create({
      schema: state.schema,
      doc: isolated.doc,
      selection: isolated.selection,
      storedMarks: state.storedMarks,
      plugins: state.plugins,
    });
    let produced: Transaction | null = null;
    const ran = command(
      middle,
      (tr) => {
        produced = tr;
      },
      view,
    );
    if (!ran) return false;
    if (!dispatch) return true;
    const combined = isolated;
    const result = produced as Transaction | null;
    if (result) {
      for (const step of result.steps) combined.step(step);
      if (result.selectionSet) {
        combined.setSelection(Selection.fromJSON(combined.doc, result.selection.toJSON()));
      }
      if (result.storedMarks) combined.setStoredMarks(result.storedMarks);
    }
    dispatch(combined.scrollIntoView());
    return true;
  };
}

/*
 * The block shortcuts the commonmark preset's input rules fire when typed at
 * the start of a paragraph (`@milkdown/preset-commonmark` src/node: bullet-list
 * `^\s*([-+*])\s$`, ordered-list `^\s*(\d+)\.\s$`, blockquote `^\s*>\s$`,
 * heading `^(?<hashes>#+)\s$`, code-block `^```(?<language>[a-z]*)?[\s\n]$`,
 * hr `^(?:---|___\s|\*\*\*\s)$`). Mirrored, not imported: the presets keep
 * their rules inside plugin instances. `@milkdown/kit` is pinned.
 */
const LINE_START_SHORTCUT =
  /^(?:\s*[-+*]\s|\s*\d+\.\s|\s*>\s|#+\s|```[a-z]*[\s\n]|---|___\s|\*\*\*\s)$/;

/** Whether `typed` — a line's text so far plus the character just typed — is a block shortcut. */
export function lineStartShortcut(typed: string): boolean {
  return LINE_START_SHORTCUT.test(typed);
}

/**
 * The `handleTextInput` direct view prop: a block shortcut typed at the start
 * of a line that is not the paragraph's first gets that line its own paragraph,
 * then hands the same keystroke to the input rules, which now see it at the
 * start of a paragraph — so `Shopping:`, Enter, `- milk` is a list, exactly as
 * it was when Enter made paragraphs.
 */
export function handleLineStartShortcut(
  view: ProseView,
  from: number,
  to: number,
  text: string,
): boolean {
  if (view.composing) return false;
  const { state } = view;
  const $from = state.doc.resolve(from);
  if (!inLinedParagraph($from) || !$from.sameParent(state.doc.resolve(to))) return false;

  let lineStart = $from.start();
  $from.parent.forEach((child, offset) => {
    const end = $from.start() + offset + child.nodeSize;
    if (isLineBreak(child) && end <= from) lineStart = end;
  });
  // The paragraph's own first line is the input rules' business already.
  if (lineStart === $from.start()) return false;
  if (!lineStartShortcut(state.doc.textBetween(lineStart, from, undefined, '\ufffc') + text)) {
    return false;
  }

  const cuts = cutsFor($from, $from);
  const tr = state.tr;
  cutLines(tr, cuts);
  view.dispatch(tr);
  const mappedFrom = mapAcrossCuts(tr, cuts, from);
  const mappedTo = mapAcrossCuts(tr, cuts, to);
  const insert = (): Transaction => view.state.tr.insertText(text, mappedFrom, mappedTo);
  const handled = view.someProp('handleTextInput', (handle) =>
    handle(view, mappedFrom, mappedTo, text, insert),
  );
  if (!handled) view.dispatch(insert());
  return true;
}

const HARDBREAK_NODE = 'hardbreak';

/**
 * The inline line break, rendered as the line break it is (`<br>`), where the
 * preset rendered CommonMark's soft line break as a space. Reads back as an
 * inline break — the `br[data-is-inline]` rule must come before the preset's
 * bare `br`, which would read it as a `\` hard break and change the file.
 *
 * Registered by the preset's own id after the preset, which replaces the node
 * in place (the pattern `@futo-notes/editor/milkdown-compat`'s doc overrides
 * use); everything but the two DOM rules is the registered entry's, so its
 * markdown runners are inherited rather than forked.
 */
export const softBreakView = $node(HARDBREAK_NODE, (ctx) => {
  const registered = ctx.get(nodesCtx).find(([id]) => id === HARDBREAK_NODE);
  if (!registered) {
    throw new Error(
      `paragraphLines: no '${HARDBREAK_NODE}' node registered before softBreakView. ` +
        'It must come after the commonmark preset.',
    );
  }
  const upstream = registered[1];
  return {
    ...upstream,
    toDOM: (node) => ['br', ctx.get(hardbreakAttr.key)(node)],
    parseDOM: [
      { tag: 'br[data-is-inline="true"]', getAttrs: () => ({ isInline: true }) },
      ...(upstream.parseDOM ?? []),
    ],
  };
});

/* The fast writes on the desktop editor: text over a range in one call, no caret, read as
 * Markdown the way the editor reads a paste (the engine's `paste`), one Undo step. Not input a
 * person produces, so `actions` marks them convenience; never the tool for checking what typing
 * does (`Type`, `Press`). Where a line ends is the only thing chosen here: what the text becomes
 * there (a list item, a heading, a line of code) is the engine's reading. */
import type { EditorView } from '$features/editor/desktop/view';
import {
  isPuppetOutcome,
  puppetRefusal as refuse,
  type Args,
  type PuppetOutcome,
  type PuppetVerb,
} from './puppetRegistry';
import type { Range } from './puppetText';
import { textAnchor, textLineOnScreen, textRangeFrom, textRangeRefusal } from './puppetTextAnchors';
import { displayTextBetween } from './puppetTextEditorReads';
import type { TextVerb } from './puppetTextVerb';

/** `text` over `range`, as a paste over a selection writes it; the receipt's `wrote`. */
function write(view: EditorView, given: Range, text: string): Record<string, unknown> {
  const range = { from: Math.min(given.from, given.to), to: Math.max(given.from, given.to) };
  const removed = displayTextBetween(view, range.from, range.to);
  view.selection.selectRange(range.from, range.to);
  view.insert(text);
  return { wrote: { ...range, removed, inserted: text } };
}

/** Where `Insert` writes: an offset on screen, or the edge of the text it is anchored to. */
function insertPoint(view: EditorView, args: Args): number | PuppetOutcome {
  const anchors = ['at', 'after', 'before'].filter((key) => args[key] !== undefined);
  if (anchors.length > 1) {
    return refuse(400, `Insert: give one of "at", "after", "before" — got ${anchors.join(', ')}`);
  }
  if (typeof args.after === 'string') {
    const range = textAnchor(view, 'after', args.after);
    return isPuppetOutcome(range) ? range : range.to;
  }
  if (typeof args.before === 'string') {
    const range = textAnchor(view, 'before', args.before);
    return isPuppetOutcome(range) ? range : range.from;
  }
  if (typeof args.at !== 'number') {
    return refuse(
      400,
      'Insert needs {"at":<offset>} or {"after":"<exact text>"}/{"before":"<exact text>"}; `doc` prints where each line starts and ends',
    );
  }
  return textRangeRefusal(view, { from: args.at, to: args.at }, args) ?? args.at;
}

/** A line's text, after its list marker unit: what `ReplaceLine` rewrites. */
function lineTextRange(view: EditorView, number: number): Range | PuppetOutcome {
  const line = textLineOnScreen(view, number);
  if (isPuppetOutcome(line)) return line;
  const marker = line.atoms.find((atom) => atom.kind === 'ListMarker');
  return { from: line.start + (marker?.end ?? 0), to: line.start + line.text.length };
}

export function textFastWriteVerbs(verb: TextVerb): PuppetVerb[] {
  const convenience = { convenience: true } as const;
  return [
    verb(
      'Insert',
      {
        at: 'integer?',
        after: 'string?',
        before: 'string?',
        text: 'string',
        docVersion: 'integer?',
      },
      (view, args) => {
        const at = insertPoint(view, args);
        return isPuppetOutcome(at) ? at : write(view, { from: at, to: at }, args.text as string);
      },
      convenience,
    ),
    verb(
      'Replace',
      {
        from: 'integer?',
        to: 'integer?',
        find: 'string?',
        text: 'string',
        expect: 'string?',
        docVersion: 'integer?',
      },
      (view, args) => {
        const range = textRangeFrom(view, args, 'Replace');
        return isPuppetOutcome(range) ? range : write(view, range, args.text as string);
      },
      convenience,
    ),
    verb(
      'ReplaceLine',
      { line: 'integer', text: 'string' },
      (view, args) => {
        const range = lineTextRange(view, args.line as number);
        return isPuppetOutcome(range) ? range : write(view, range, args.text as string);
      },
      convenience,
    ),
    // A new line after line N's end (0: before line 1), as a paste of a line break and the text
    // there writes it.
    verb(
      'InsertLine',
      { afterLine: 'integer', text: 'string' },
      (view, args) => {
        const afterLine = args.afterLine as number;
        const text = args.text as string;
        if (afterLine === 0) {
          const top = textLineOnScreen(view, 1);
          if (isPuppetOutcome(top)) return top;
          return write(view, { from: 0, to: 0 }, `${text}\n`);
        }
        const line = textLineOnScreen(view, afterLine);
        if (isPuppetOutcome(line)) return line;
        const end = line.start + line.text.length;
        return write(view, { from: end, to: end }, `\n${text}`);
      },
      convenience,
    ),
    // At the note's end: into its last line while that is empty, else on a line of its own.
    verb(
      'AppendLine',
      { text: 'string' },
      (view, args) => {
        const lines = view.displayLines();
        const last = lines[lines.length - 1];
        const end = last ? last.start + last.text.length : 0;
        const text = args.text as string;
        const empty = !last || last.text === '';
        return write(view, { from: end, to: end }, empty ? text : `\n${text}`);
      },
      convenience,
    ),
  ];
}

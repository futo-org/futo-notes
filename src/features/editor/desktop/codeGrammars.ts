/* The grammars that colour code blocks (codeColours.ts), and their parsing: loaded with the first
 * block that names a language (a dynamic import), so a note without one loads none of it. A
 * block's language as written is looked up in the curated list (codeFenceLanguages.ts) by name
 * or alias, ignoring case, as the Milkdown editor does; each grammar is fetched the first time a
 * block uses it. A block is parsed whole, again only where it changed (Lezer's incremental
 * parse), and in slices: the caller says when to stop. */
import { LanguageDescription } from '@codemirror/language';
import { TreeFragment, type Parser, type PartialParse, type Tree } from '@lezer/common';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { codeFenceLanguages } from '../codeFenceLanguages';
import type { ColourRun } from './lineModel';

/** A block's text and its tree under `parser`. */
export interface ParsedBlock {
  parser: Parser;
  text: string;
  tree: Tree;
}

/** A parse of a block's `text` under way; its text differs from the one parsed before from
 *  `changedFrom` on (UTF-16). */
export interface BlockParse {
  parser: Parser;
  text: string;
  partial: PartialParse;
  changedFrom: number;
}

/** The grammars whose load failed: their blocks stay uncoloured, never asked for again. */
const failedGrammars = new Set<LanguageDescription>();

/** The parser for the curated grammar `language` names; null when none does (or it would not
 *  load); while it loads, the load, settled either way. */
export function grammarParser(language: string): Parser | Promise<void> | null {
  const description = LanguageDescription.matchLanguageName(codeFenceLanguages, language, true);
  if (!description || failedGrammars.has(description)) return null;
  if (description.support) return description.support.language.parser;
  return description.load().then(
    () => undefined,
    () => {
      failedGrammars.add(description);
    },
  );
}

/** Start parsing `text` under `parser`, from `previous` (the block parsed before under the same
 *  parser) where it is unchanged. */
export function startBlockParse(
  parser: Parser,
  text: string,
  previous: ParsedBlock | null,
): BlockParse {
  if (!previous || previous.parser !== parser) {
    return { parser, text, partial: parser.startParse(text), changedFrom: 0 };
  }
  const old = previous.text;
  const most = Math.min(old.length, text.length);
  let from = 0;
  while (from < most && old.charCodeAt(from) === text.charCodeAt(from)) from++;
  let oldEnd = old.length;
  let newEnd = text.length;
  while (
    oldEnd > from &&
    newEnd > from &&
    old.charCodeAt(oldEnd - 1) === text.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }
  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(previous.tree), [
    { fromA: from, toA: oldEnd, fromB: from, toB: newEnd },
  ]);
  return { parser, text, partial: parser.startParse(text, fragments), changedFrom: from };
}

/** Work on `parse` until it is done or the clock passes `deadline` (`performance.now()`); the
 *  parsed block once done. */
export function advanceBlockParse(parse: BlockParse, deadline: number): ParsedBlock | null {
  do {
    const tree = parse.partial.advance();
    if (tree) return { parser: parse.parser, text: parse.text, tree };
  } while (performance.now() < deadline);
  return null;
}

/** The colours of lines `from` to `to` of `block`, whose lines start at `lineStarts` in its
 *  text (each ends before the next one's `\n`): one list per line, in UTF-16 units from its
 *  start. A token over several lines is cut at each line's end. */
export function blockLineColours(
  block: ParsedBlock,
  lineStarts: readonly number[],
  from: number,
  to: number,
): ColourRun[][] {
  const colours = Array.from({ length: to - from }, (): ColourRun[] => []);
  const lineEnd = (index: number) => (lineStarts[index + 1] ?? block.text.length + 1) - 1;
  let line = from;
  const put = (start: number, end: number, className: string) => {
    while (line < to && start >= lineEnd(line)) line++;
    for (let index = line; index < to && lineStarts[index] < end; index++) {
      const lineStart = lineStarts[index];
      const runStart = Math.max(start, lineStart) - lineStart;
      const runEnd = Math.min(end, lineEnd(index)) - lineStart;
      if (runEnd > runStart)
        colours[index - from].push({ start: runStart, end: runEnd, className });
    }
  };
  highlightTree(block.tree, classHighlighter, put, lineStarts[from], lineEnd(to - 1));
  return colours;
}

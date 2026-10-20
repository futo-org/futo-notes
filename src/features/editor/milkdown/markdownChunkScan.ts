import type { ChunkDeclineReason } from './markdownChunkOptions';
import {
  indentWidth,
  isBlank,
  LIST_MARKER,
  definitionLabel,
  parseFenceOpen,
  BLOCKQUOTE_LINE,
  ATX_HEADING,
  INTERRUPTING_LIST_ITEM,
  TABLE_DELIMITER_ROW,
  HTML_BLOCK_START,
  CONTAINED_HTML_START,
  CONTAINED_FENCE,
} from './markdownChunkLines';

export interface ScanState {
  /** An open column-0 fence. (Any other fence stops the scan; see `lineOffense`.) */
  fence: { marker: string; length: number } | null;
  /**
   * Indent of the last line that carried content. A cut coming out of a region
   * indented 4+ is unsafe: that is an indented code block (or a deep container
   * continuation), and which of its trailing blank lines belong to it is
   * settled by what follows — context a chunk boundary removes.
   */
  lastContentIndent: number;
  /**
   * Whether a top-level LIST is currently open. Not "the last line looked like
   * a list": `- a` / `continuation at column 0` / blank / `- b` is ONE loose
   * list in CommonMark, and so is a list whose item holds an indented fenced
   * code block. Both used to close this flag early, which let the planner cut
   * one list into two — and two adjacent lists have to be serialized with
   * DIFFERENT bullets (`*` then `-`, `3.` then `3)`) or they would merge back
   * into one. That was 73 of the corpus's first 153 divergences.
   */
  inList: boolean;
  /**
   * Whether a top-level BLOCKQUOTE is currently open. A lazy continuation line
   * (plain text, no `>`) does NOT close it — CommonMark keeps reading it as
   * part of the quote — so nothing after one may be offered as a NEW
   * top-level block until a hard starter or a blank line closes it. Cleared
   * by: a blank line, a column-0 ATX heading, a column-0 fence opener, or a
   * column-0 INTERRUPTING list item — each of those closes an open blockquote
   * exactly as it closes an open list.
   */
  inBlockquote: boolean;
  /** A GFM table may be open; see `TABLE_DELIMITER_ROW`. */
  tableUntilBlank: boolean;
  /** Whether the PREVIOUS line was blank — i.e. the next line may start a block. */
  prevLineBlank: boolean;
  /** A `[` that could open a definition label is still unclosed; see {@link definitionLabel}. */
  labelOpen: boolean;
}

/**
 * Why the scanner can no longer vouch for the note from this line on, or null.
 *
 * `raw` is judged in the scanner's current state: inside a fence only the
 * line-splitting rules apply (BOM, CR, U+2028/9, non-space blanks — micromark
 * applies those there too); a tag or `]:` inside a column-0 fence is code, not
 * HTML or a definition.
 */
export function lineOffense(
  state: ScanState,
  raw: string,
  inFrontMatter = false,
): ChunkDeclineReason | null {
  const bare = raw.replace(/\r?\n$/, '');
  /* U+FEFF: micromark strips one at the start of any parse, so a chunk may
   * never start at one, and remark's marker lookup is offset by it. */
  if (bare.includes('\ufeff')) return 'bom';
  /* A lone CR is a line ending to micromark and not to `split(/(?<=\n)/)`;
   * `.` and `$` in the scanner's regexes stop at U+2028/U+2029. */
  if (bare.includes('\r') || bare.includes('\u2028') || bare.includes('\u2029')) {
    return 'line-ending';
  }
  /* `trim()`-blank but not space/tab-blank: NBSP, U+3000, \f, \v, ... */
  if (bare.trim() === '') return isBlank(bare) ? null : 'unicode-blank';
  /* The note's own front matter is YAML, not markdown: a fence-looking or tag-
   * looking line in it is not one (and must not open a phantom fence). */
  if (state.fence || inFrontMatter) return null;
  if (HTML_BLOCK_START.test(bare) || CONTAINED_HTML_START.test(bare)) return 'html-block';
  /* A fence indented 1–3 closes by a rule the enclosing block decides (a
   * column-0 line closes it implicitly, and a column-0 run then opens a NEW
   * fence): the scanner was a whole code block out of step with micromark. */
  if (CONTAINED_FENCE.test(bare)) return 'unprovable-fence';
  if (parseFenceOpen(bare) !== null && indentWidth(bare) !== 0) return 'unprovable-fence';
  if (definitionLabel(bare, state.labelOpen).hit) return 'reference-definition';
  return null;
}

/** Advances `state` over one line. */
export function advance(state: ScanState, raw: string): void {
  const line = raw.replace(/\r?\n$/, '');

  if (state.fence) {
    /* Space/tab only after the closer: `\\s` would also accept NBSP, which
     * CommonMark does not. */
    const closing = new RegExp(`^ {0,3}${state.fence.marker}{${state.fence.length},}[ \\t]*$`);
    if (closing.test(line)) state.fence = null;
    state.prevLineBlank = false;
    state.lastContentIndent = indentWidth(line);
    return;
  }

  if (isBlank(line)) {
    state.labelOpen = false;
    state.prevLineBlank = true;
    // A blank line closes every "until blank" tracked construct.
    state.inBlockquote = false;
    state.tableUntilBlank = false;
    return;
  }

  state.lastContentIndent = indentWidth(line);
  state.labelOpen = definitionLabel(line, state.labelOpen).labelOpen;

  const atTopLevel = indentWidth(line) === 0;
  /* A line begins a new TOP-LEVEL block when it starts at column 0 after a
   * blank. Without the blank it is a continuation of whatever is already open
   * (a lazy paragraph line inside a list item is indistinguishable from a new
   * paragraph otherwise) — except a list marker, which CommonMark lets
   * interrupt a paragraph. */
  const startsTopLevelBlock = atTopLevel && state.prevLineBlank;
  const looksLikeListItem = LIST_MARKER.test(line);
  const interrupts = atTopLevel && INTERRUPTING_LIST_ITEM.test(line);

  const fenceOpen = parseFenceOpen(line);
  if (fenceOpen) {
    state.fence = { marker: fenceOpen.marker, length: fenceOpen.length };
    /* A column-0 fence opener closes an open list or blockquote even without a
     * preceding blank line — it is one of CommonMark's hard block starts. */
    state.inList = false;
    state.inBlockquote = false;
    state.prevLineBlank = false;
    state.lastContentIndent = 0;
    return;
  }

  if (atTopLevel && ATX_HEADING.test(line)) {
    /* A column-0 ATX heading closes an open list or blockquote even without a
     * preceding blank line, same as a fence opener. */
    state.inList = false;
    state.inBlockquote = false;
    state.prevLineBlank = false;
    return;
  }

  if (TABLE_DELIMITER_ROW.test(line)) state.tableUntilBlank = true;

  if (BLOCKQUOTE_LINE.test(line)) {
    state.inBlockquote = true;
    if (atTopLevel) state.inList = false;
  } else if (interrupts) {
    // A column-0 interrupting list item closes an open blockquote too.
    state.inBlockquote = false;
  }

  /* Any marker indented less than 4 is a list item near the top level — the
   * regex already caps the indent at 3. `  - a` under a paragraph opens a list
   * just as `- a` does, and a later `- b` at column 0 after a blank line
   * continues THAT list rather than starting a new one. */
  if (looksLikeListItem) state.inList = true;
  else if (startsTopLevelBlock) state.inList = false;
  state.prevLineBlank = false;
}

/**
 * Whether `bare` may start a new top-level block regardless of what precedes
 * it — CommonMark's "interrupting" constructs. Only checked when the previous
 * line was NOT blank (the blank case is the existing, simpler rule) and the
 * line sits at column 0 outside every protected/tracked construct; see the
 * module header table for the constructs that gate this.
 */
export function isHardStarter(bare: string, state: ScanState): boolean {
  /* `- | -` is both an INTERRUPTING_LIST_ITEM and a GFM table delimiter row —
   * remark-gfm reads `a | b` / `- | -` / `c | d` as ONE table, so cutting in
   * front of the delimiter row would turn it into a paragraph plus a list.
   * A table delimiter row is never a hard starter, whatever else it matches. */
  if (TABLE_DELIMITER_ROW.test(bare)) return false;
  if (ATX_HEADING.test(bare)) return true;
  if (parseFenceOpen(bare) !== null) return true;
  if (BLOCKQUOTE_LINE.test(bare) && !state.inBlockquote) return true;
  if (INTERRUPTING_LIST_ITEM.test(bare) && !state.inList) return true;
  return false;
}

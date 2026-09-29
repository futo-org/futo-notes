/**
 * Splits a markdown document into top-level chunks that can be parsed
 * INDEPENDENTLY and concatenated back into the same ProseMirror document a
 * whole-document parse would have produced.
 *
 * This is the "parse" half of progressive open (docs/plan/milkdown-transition.md
 * §5, issue #105): a 14k-line note costs ~870 ms of remark parse, so the first
 * screen can only be interactive quickly if the rest of the parse is deferred.
 * `progressiveLoad.ts` owns the mounting and the save lock; this module owns
 * only WHERE it is safe to cut.
 *
 * Two properties matter, in this order:
 *
 *   1. **Lossless.** `plan.chunks.join('') === markdown`, always, for every
 *      input including the empty document. Every byte of the note reaches the
 *      editor exactly once, in order, whatever the scanner decided.
 *   2. **Equivalent.** Parsing the chunks separately and appending must produce
 *      the same document as parsing the whole string. That is NOT true of an
 *      arbitrary blank-line split, so the scanner below only cuts where block
 *      context provably cannot cross the gap — and where it cannot prove that,
 *      it declines and the caller loads the note the old way.
 *
 * Declining is cheap and correct: the whole-document parse is exactly today's
 * behavior. `scripts/milkdown-chunk-census.mjs` measures how often it happens
 * and proves property 2 against the real editor over the note corpus.
 *
 * THE RULE: this scanner is a line-based approximation of micromark, and every
 * time it was patched to agree with micromark on one more shape (an indented
 * fence closed at column 0, a fence under an HTML block, a lone CR, an
 * NBSP-only line, a definition in a list item, ...) the release-hardening
 * fuzz found the next shape. So it does not try to model what it cannot prove.
 * It cuts only while every line so far is a construct it tracks exactly, and
 * the moment it meets one it cannot prove is top-level and block-bounded it
 * STOPS CUTTING: the lines before that point were understood exactly, so their
 * cuts stand; the offending line and everything after it is one last chunk,
 * parsed as a piece. (When nothing was cut before it, the note loads whole.)
 *
 * | Construct | Why it stops the scan |
 * |---|---|
 * | Any HTML block start (a line opening `<tag`, `<!`, `<?`, `</`) | ends by rules (blank line, `-->`, `</pre>`, ...) that interact with fences and paragraphs in ways the scanner got wrong twice |
 * | A fence indented 1–3, or opened after a list/quote marker | its close is decided by the enclosing container, which a chunk boundary removes |
 * | A lone CR, U+2028/U+2029 | micromark ends a line at a lone CR; `.` and `$` in the scanner's regexes stop at U+2028/9 |
 * | A line of only whitespace other than space/tab (NBSP, U+3000, `\f`, ...) | `String#trim` calls it blank; CommonMark calls it a paragraph line |
 * | U+FEFF anywhere but the very start | micromark strips a chunk-leading one, so a chunk must never start at it |
 *
 * One construct cannot be handled by stopping, because it acts BACKWARDS: any
 * `]:` outside a fence (a link reference or footnote definition) declines the
 * whole note. Definitions resolve document-wide — a `[foo]` in chunk 1 whose
 * definition lands in chunk 3 parses as literal text — and they hide in list
 * items and quotes and behind escaped `]` and two-line labels. After the scan
 * has stopped, the rest of the note is searched for `]:` without regard to
 * fences.
 *
 * A LEADING U+FEFF is scanned as if it were absent (the parser strips it too,
 * see `parseNote.ts`); it stays in the first chunk so the chunks still join
 * back to the input.
 *
 * What can cross a blank line, and how each tracked construct is handled:
 *
 * | Construct | Handling |
 * |---|---|
 * | Fenced code block at column 0 | tracked; blank lines inside are never boundaries |
 * | Indented code block | next line must start at column 0; never cut out of an indent-4 region |
 * | List item continuation | next line must start at column 0 |
 * | Loose list (`- a` / blank / `- b` is ONE list) | a list is never followed by a list marker |
 * | A `---` fence | never a boundary: at the start of a chunk it would parse as FRONT MATTER |
 *
 * A cut point is not only the line AFTER a blank line: CommonMark guarantees a
 * NEW top-level block starts at a column-0 ATX heading, fence opener,
 * blockquote start, or "interrupting" list item (a non-empty bullet, or an
 * ordered item starting at `1`), regardless of what precedes it — the same
 * rule that lets these constructs interrupt a paragraph without a blank line.
 * This is what makes a note with no blank line anywhere (`tests/lib/editorDevicePerf.mjs`'s
 * `lineFixture`, and the largest declined corpus notes) chunkable. Two more
 * things must stay closed for it to be safe:
 *
 * | Construct | Handling |
 * |---|---|
 * | A GFM table | tracked from its delimiter row; ends only at a blank line, over-approximated |
 * | An open top-level blockquote | tracked; a lazy continuation line does NOT close it, so nothing after it may cut in as a NEW block until a hard starter or blank line closes the quote |
 */

/** How a plan chose its cut points. */
export interface MarkdownChunkOptions {
  /**
   * Documents with fewer lines than this are loaded whole. Progressive open
   * exists for the notes where parse is visible; below the threshold the
   * machinery is pure risk for no gain.
   */
  minLines?: number;
  /**
   * Line budget for the FIRST chunk — the one the user waits for. Deliberately
   * far smaller than the rest: it only has to fill a viewport.
   */
  firstChunkLines?: number;
  /** Line budget for every later chunk, where throughput beats latency. */
  chunkLines?: number;
}

/** Why a document is being loaded whole instead of progressively. */
export type ChunkDeclineReason =
  | 'too-short'
  | 'reference-definition'
  | 'html-block'
  | 'unprovable-fence'
  | 'line-ending'
  | 'unicode-blank'
  | 'bom'
  | 'no-boundary';

export interface MarkdownChunkPlan {
  /** In order; always concatenates back to the exact input. */
  chunks: string[];
  /** False when `chunks` is the whole document as one entry. */
  chunked: boolean;
  /** Set only when `chunked` is false. */
  declined?: ChunkDeclineReason;
  /**
   * Set when the scanner stopped trusting itself part-way: the chunks before
   * the last cut are proven, and the last chunk runs from that cut to the end
   * of the note and is parsed as one piece.
   */
  stoppedBy?: ChunkDeclineReason;
}

export const DEFAULT_CHUNK_OPTIONS: Required<MarkdownChunkOptions> = {
  /* ~4x the largest note that is not a "large note": the population study in
   * the plan doc puts the maintainer's second-largest note at 978 lines, so
   * everything an ordinary vault holds loads exactly as it does today. */
  minLines: 400,
  /* A phone viewport is ~30 short lines; 80 covers a laptop window with the
   * headroom to scroll a screen before the next chunk lands. */
  firstChunkLines: 80,
  chunkLines: 500,
};

/** Leading-whitespace width, counting a tab as the 4 columns CommonMark gives it. */
function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

/**
 * CommonMark's blank line: only space and tab. NOT `String#trim`, which also
 * strips NBSP and friends; `lineOffense` stops the scan before that
 * difference can matter, so the two agree on every line the scanner reaches.
 */
function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

/** `- `, `* `, `+ `, `1. `, `1) ` — a list-item marker starting a line. */
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/**
 * A list marker with NOTHING after it. What such a line means depends on the
 * block before it — CommonMark forbids an empty item from interrupting a
 * paragraph, and remark also declines to start a list with one directly after
 * an indented code block, parsing it as a paragraph instead. Give it a chunk of
 * its own and it loses that context and becomes an empty list item: 7 of the
 * corpus's remaining divergences, all of them a `- ` under a tab-indented
 * template line. Cutting in front of one is never safe.
 */
const EMPTY_LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]*$/;

/**
 * Where a link reference definition (`[label]: dest`) or a GFM footnote
 * definition (`[^1]: text`) can begin: a `[` after nothing but container
 * markers (`>`, `- `, `1. `) and whitespace. Both kinds resolve across the
 * WHOLE document — a `[foo]` in chunk 1 whose definition lands in chunk 3
 * parses as literal text when the chunks are parsed apart — so one anywhere
 * makes the document ineligible.
 *
 * This is a deliberately loose reading of the grammar, not a model of it: the
 * definition may sit in a list item or a blockquote, carry an escaped `]` in
 * its label, or break its label over lines, and every one still begins with
 * `[` at the start of a line and still has a `]:` where the label ends.
 */
const DEFINITION_START = /^(?:[ \t]|>|(?:[-*+]|\d{1,9}[.)])(?=[ \t]))*\[/;

/**
 * Whether `bare` could be (the end of) a definition's label line, given whether
 * an earlier line of this paragraph opened a `[` that has not closed yet.
 * Returns the new "label still open" flag alongside.
 */
function definitionLabel(bare: string, labelOpen: boolean): { hit: boolean; labelOpen: boolean } {
  const starts = DEFINITION_START.test(bare);
  // An escaped `]` does not end a label.
  const closes = bare.replace(/\\./g, '').includes(']');
  return {
    hit: bare.includes(']:') && (starts || labelOpen),
    labelOpen: (starts || labelOpen) && !closes,
  };
}

/** Opening fence: 3+ backticks or tildes, indented at most 3, plus its info string. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Parses a fence-opener line, or returns null. Shared by `advance` (which
 * tracks the open fence) and the non-blank boundary rule (which treats any
 * fence opener as a hard starter) so the backtick-info-string exception below
 * is checked in exactly one place.
 */
function parseFenceOpen(line: string): { marker: string; length: number } | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  /* A backtick fence's info string may not contain a backtick — ```` ```toml` ````
   * is a PARAGRAPH, not a code block. See `advance`'s comment at its call site
   * for what reading it as a fence used to break. */
  if (match[1][0] === '`' && match[2].includes('`')) return null;
  return { marker: match[1][0], length: match[1].length };
}

/** A top-level (column-0..3) blockquote marker. */
const BLOCKQUOTE_LINE = /^ {0,3}>/;

/**
 * ATX heading: `#` through `######`, followed by a space/tab or end of line.
 * Column-0 only is enforced by the caller (see the boundary rule) rather than
 * here, because `advance` also needs to know about an indented heading-shaped
 * line reading as a lazy continuation, not a heading.
 */
const ATX_HEADING = /^#{1,6}(?:[ \t]|$)/;

/**
 * A list item that CommonMark lets interrupt a paragraph without a blank
 * line: a non-empty bullet, or an ordered item starting at exactly `1`. `2. x`
 * and an empty `- ` cannot interrupt, so neither is a hard starter.
 */
const INTERRUPTING_LIST_ITEM = /^(?:[-*+]|1[.)])[ \t]+\S/;

/**
 * A GFM table delimiter row (`| --- | :-: |`, or the bare `---` shape, which
 * is harmless here since a lone `---` is never a hard starter anyway). Once
 * seen, the table is presumed open until a blank line — deliberately
 * over-approximated the same way the HTML-block-6/7 tracking below is: the
 * cost of treating a false positive as "still a table" is a missed cut, never
 * a wrong one.
 */
const TABLE_DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/**
 * The start of ANY HTML block (CommonMark types 1–7: `<pre`, `<!--`, `<?`,
 * `<!X`, `<![CDATA[`, a block tag, or any bare tag/closing tag). Deliberately
 * over-approximate: a paragraph that begins with an inline tag or an autolink
 * also matches. An HTML block's end condition depends on its type, and on
 * whether a fence or another starter appears inside it; the scanner used to
 * track that and disagreed with micromark twice, so any match declines.
 */
const HTML_BLOCK_START = /^ {0,3}<[A-Za-z/!?]/;

/**
 * A fence marker run that follows only whitespace and container markers
 * (`- `, `1. `, `> `), with something in front of it. At column 0 the scanner
 * tracks a fence exactly; anywhere else its closing rule belongs to the
 * enclosing container and the scanner cannot prove where it ends.
 */
const CONTAINED_FENCE = /^[ \t>*+\-\d.)]+(?:`{3,}|~{3,})/;

/**
 * A line that would open YAML front matter if it were the first line of a
 * document: exactly `---` at column 0, nothing after it but whitespace
 * (micromark-extension-frontmatter's opening condition — `----` and ` ---` are
 * thematic breaks, not fences).
 *
 * Front matter is a document-START construct, and each chunk is parsed as its
 * own little document (`packages/editor/src/milkdown-compat/frontmatter.ts`).
 * So a chunk that BEGAN with one of these would turn a mid-note thematic break
 * plus setext heading into a front matter node, which cannot be appended to a
 * document that is already past its first position — ProseMirror would drop it,
 * losing those bytes. Refusing the boundary costs one larger chunk; the planner
 * has plenty of others, and a document with no other boundary declines and
 * loads whole, which is exactly today's behavior.
 */
const FRONT_MATTER_FENCE = /^---[ \t]*$/;

/**
 * The line index the document's OWN front matter block ends after, or 0 when it
 * has none. No boundary may fall at or before it.
 *
 * Front matter can contain a blank line followed by a column-0 line — which is
 * exactly what the scanner reads as a top-level block start — so without this a
 * `---\na: 1\n\nb: 2\n---` block would be cut in half, and each half parsed
 * apart is neither front matter nor what it was. `remark-frontmatter` requires
 * the closing fence to be exactly `---` too, and requires it to exist: with no
 * closing fence there is no front matter, so there is nothing to protect.
 */
function frontMatterEndLine(lines: string[]): number {
  if (lines.length === 0) return 0;
  if (!FRONT_MATTER_FENCE.test(lines[0].replace(/\r?\n$/, ''))) return 0;
  for (let i = 1; i < lines.length; i += 1) {
    if (FRONT_MATTER_FENCE.test(lines[i].replace(/\r?\n$/, ''))) return i + 1;
  }
  return 0;
}

/** Splits into lines, each keeping its own terminator, so a join is byte-exact. */
function splitKeepingLineEndings(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/(?<=\n)/);
  return lines;
}

interface ScanState {
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
function lineOffense(state: ScanState, raw: string): ChunkDeclineReason | null {
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
  if (state.fence) return null;
  if (HTML_BLOCK_START.test(bare)) return 'html-block';
  /* A fence indented 1–3 closes by a rule the enclosing block decides (a
   * column-0 line closes it implicitly, and a column-0 run then opens a NEW
   * fence): the scanner was a whole code block out of step with micromark. */
  if (CONTAINED_FENCE.test(bare)) return 'unprovable-fence';
  if (parseFenceOpen(bare) !== null && indentWidth(bare) !== 0) return 'unprovable-fence';
  if (definitionLabel(bare, state.labelOpen).hit) return 'reference-definition';
  return null;
}

/** Advances `state` over one line. */
function advance(state: ScanState, raw: string): void {
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
function isHardStarter(bare: string, state: ScanState): boolean {
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

/**
 * Plans the chunks for `markdown`.
 *
 * Never throws and never loses a byte: the worst case is a one-entry plan
 * holding the whole document, which is what the editor did before progressive
 * open existed.
 */
export function planMarkdownChunks(
  markdown: string,
  options: MarkdownChunkOptions = {},
): MarkdownChunkPlan {
  const { minLines, firstChunkLines, chunkLines } = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const whole = (declined: ChunkDeclineReason): MarkdownChunkPlan => ({
    chunks: [markdown],
    chunked: false,
    declined,
  });

  const lines = splitKeepingLineEndings(markdown);
  if (lines.length < minLines) return whole('too-short');

  /* Scan a copy without a LEADING U+FEFF; the parser strips exactly that one
   * (`parseNote.ts`), so line 0's front-matter fence and block structure are
   * what the scanner should see. `lines` keeps the byte for the join. */
  const scan = lines.slice();
  if (scan[0]?.charCodeAt(0) === 0xfeff) scan[0] = scan[0].slice(1);

  let stoppedBy: ChunkDeclineReason | null = null;
  let stoppedAt = scan.length;

  const state: ScanState = {
    fence: null,
    lastContentIndent: 0,
    inList: false,
    inBlockquote: false,
    tableUntilBlank: false,
    prevLineBlank: true,
    labelOpen: false,
  };

  /** Line indices a chunk may START at, in order. */
  const boundaries: number[] = [];

  /* Everything up to and including the note's own front matter belongs to the
   * first chunk (see {@link frontMatterEndLine}). */
  const frontMatterEnd = frontMatterEndLine(scan);

  for (let i = 0; i < scan.length; i += 1) {
    const offense = lineOffense(state, scan[i]);
    if (offense === 'reference-definition') return whole(offense);
    if (offense) {
      stoppedBy = offense;
      stoppedAt = i;
      break;
    }
    const bare = scan[i].replace(/\r?\n$/, '');
    const inProtectedBlock = state.fence !== null;

    /* An EMPTY line, not merely a blank one. A line of spaces reads as blank at
     * the top level but is content inside an indented code block, and whether
     * such a line ends the block is decided by what follows it — so it is not a
     * place to cut. */
    if (!inProtectedBlock && bare === '' && state.lastContentIndent < 4) {
      // Look past the whole blank run: the boundary sits before the next line
      // that actually carries content, and the blank run stays with the chunk
      // that precedes it.
      let next = i + 1;
      while (next < scan.length && isBlank(scan[next].replace(/\r?\n$/, ''))) next += 1;
      if (next < scan.length) {
        const nextLine = scan[next].replace(/\r?\n$/, '');
        const startsAtColumnZero = indentWidth(nextLine) === 0;
        const wouldFuseLists = state.inList && LIST_MARKER.test(nextLine);
        const dependsOnWhatPrecedes = EMPTY_LIST_ITEM.test(nextLine);
        const wouldOpenFrontMatter = FRONT_MATTER_FENCE.test(nextLine);
        const insideOwnFrontMatter = next < frontMatterEnd;
        if (
          startsAtColumnZero &&
          !wouldFuseLists &&
          !dependsOnWhatPrecedes &&
          !wouldOpenFrontMatter &&
          !insideOwnFrontMatter
        ) {
          boundaries.push(next);
        }
      }
    } else if (
      i > 0 &&
      !inProtectedBlock &&
      !state.tableUntilBlank &&
      !state.prevLineBlank &&
      i >= frontMatterEnd &&
      indentWidth(bare) === 0 &&
      isHardStarter(bare, state)
    ) {
      // A hard starter cuts even without a preceding blank line.
      boundaries.push(i);
    }

    advance(state, scan[i]);
  }

  if (stoppedBy) {
    /* Definitions resolve document-wide, so the tail still gets a check for
     * one — context-free, since the scanner no longer knows what is a fence. */
    let labelOpen = false;
    for (let i = stoppedAt; i < scan.length; i += 1) {
      const bare = scan[i].replace(/\r?\n$/, '');
      if (isBlank(bare)) {
        labelOpen = false;
        continue;
      }
      const label = definitionLabel(bare, labelOpen);
      if (label.hit) return whole('reference-definition');
      labelOpen = label.labelOpen;
    }
    /* Everything from the offending line on is one chunk: a cut needs a
     * proven state, and a cut AT the line could start a chunk with a U+FEFF. */
    while (boundaries.length > 0 && boundaries[boundaries.length - 1] >= stoppedAt) {
      boundaries.pop();
    }
  }
  if (boundaries.length === 0) return whole(stoppedBy ?? 'no-boundary');

  const chunks: string[] = [];
  let start = 0;
  let budget = firstChunkLines;
  for (const boundary of boundaries) {
    if (boundary - start < budget) continue;
    chunks.push(lines.slice(start, boundary).join(''));
    start = boundary;
    budget = chunkLines;
  }
  chunks.push(lines.slice(start).join(''));

  if (chunks.length < 2) return whole('no-boundary');
  return stoppedBy ? { chunks, chunked: true, stoppedBy } : { chunks, chunked: true };
}

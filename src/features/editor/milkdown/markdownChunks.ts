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
 * What can cross a blank line, and how each is handled:
 *
 * | Construct | Handling |
 * |---|---|
 * | Fenced code block | tracked; blank lines inside are never boundaries |
 * | HTML blocks 1–5 (`<pre>`, `<!--`, `<?`, `<!X`, `<![CDATA[`) | tracked to their end condition |
 * | Indented code block | next line must start at column 0; never cut out of an indent-4 region |
 * | List item continuation | next line must start at column 0 |
 * | Loose list (`- a` / blank / `- b` is ONE list) | a list is never followed by a list marker |
 * | Link reference definitions, GFM footnote definitions | document-scoped, so the whole document declines |
 * | A `---` fence | never a boundary: at the start of a chunk it would parse as FRONT MATTER |
 *
 * HTML blocks 6 and 7 end AT a blank line by definition, so a blank line after
 * one is a genuine boundary and needs no tracking.
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
export type ChunkDeclineReason = 'too-short' | 'reference-definition' | 'no-boundary';

export interface MarkdownChunkPlan {
  /** In order; always concatenates back to the exact input. */
  chunks: string[];
  /** False when `chunks` is the whole document as one entry. */
  chunked: boolean;
  /** Set only when `chunked` is false. */
  declined?: ChunkDeclineReason;
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

function isBlank(line: string): boolean {
  return line.trim() === '';
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
 * A link reference definition (`[label]: dest`) or a GFM footnote definition
 * (`[^1]: text`). Both resolve across the WHOLE document — a `[foo]` in chunk 1
 * whose definition lands in chunk 3 parses as literal text when the chunks are
 * parsed apart — so one of these anywhere makes the document ineligible.
 */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]*\]:/;

/** Opening fence: 3+ backticks or tildes, indented at most 3, plus its info string. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

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

/** HTML block start conditions 1–5: the ones that can contain a blank line. */
const HTML_BLOCK_STARTS: ReadonlyArray<{ start: RegExp; end: RegExp }> = [
  {
    start: /^ {0,3}<(?:pre|script|style|textarea)(?:[\s>]|$)/i,
    end: /<\/(?:pre|script|style|textarea)>/i,
  },
  { start: /^ {0,3}<!--/, end: /-->/ },
  { start: /^ {0,3}<\?/, end: /\?>/ },
  { start: /^ {0,3}<![A-Za-z]/, end: />/ },
  { start: /^ {0,3}<!\[CDATA\[/, end: /\]\]>/ },
];

/** Splits into lines, each keeping its own terminator, so a join is byte-exact. */
function splitKeepingLineEndings(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/(?<=\n)/);
  return lines;
}

interface ScanState {
  fence: { marker: string; length: number; indent: number } | null;
  htmlEnd: RegExp | null;
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
  /** Whether the PREVIOUS line was blank — i.e. the next line may start a block. */
  prevLineBlank: boolean;
  sawReferenceDefinition: boolean;
}

/** Advances `state` over one line. */
function advance(state: ScanState, raw: string): void {
  const line = raw.replace(/\r?\n$/, '');

  if (state.fence) {
    /* A fence opened inside a container (a list item, so indented) cannot be
     * closed by a line at column 0: that line is outside the container, and
     * CommonMark closes the fence implicitly at the container's end and lets
     * the column-0 run open a NEW fence. Treating it as a closer put the
     * scanner a whole code block out of step with remark. */
    const minCloseIndent = state.fence.indent > 0 ? 1 : 0;
    const closing = new RegExp(`^ {0,3}${state.fence.marker}{${state.fence.length},}\\s*$`);
    if (closing.test(line) && indentWidth(line) >= minCloseIndent) state.fence = null;
    state.prevLineBlank = false;
    state.lastContentIndent = indentWidth(line);
    return;
  }

  if (state.htmlEnd) {
    if (state.htmlEnd.test(line)) state.htmlEnd = null;
    state.prevLineBlank = false;
    state.lastContentIndent = indentWidth(line);
    return;
  }

  if (isBlank(line)) {
    state.prevLineBlank = true;
    return;
  }

  state.lastContentIndent = indentWidth(line);

  const atTopLevel = indentWidth(line) === 0;
  /* A line begins a new TOP-LEVEL block when it starts at column 0 after a
   * blank. Without the blank it is a continuation of whatever is already open
   * (a lazy paragraph line inside a list item is indistinguishable from a new
   * paragraph otherwise) — except a list marker, which CommonMark lets
   * interrupt a paragraph. */
  const startsTopLevelBlock = atTopLevel && state.prevLineBlank;
  const looksLikeListItem = LIST_MARKER.test(line);

  const fenceOpen = FENCE_OPEN.exec(line);
  /* A backtick fence's info string may not contain a backtick — ```` ```toml` ````
   * is a PARAGRAPH, not a code block. Reading it as a fence opened one the
   * scanner then never closed, and every boundary for the rest of the note
   * disagreed with remark about what was code. */
  const isFence = fenceOpen !== null && !(fenceOpen[1][0] === '`' && fenceOpen[2].includes('`'));
  if (fenceOpen && isFence) {
    state.fence = {
      marker: fenceOpen[1][0],
      length: fenceOpen[1].length,
      indent: indentWidth(line),
    };
    if (startsTopLevelBlock) state.inList = false;
    state.prevLineBlank = false;
    state.lastContentIndent = indentWidth(line);
    return;
  }

  for (const { start, end } of HTML_BLOCK_STARTS) {
    if (!start.test(line)) continue;
    // A block that opens and closes on the same line never spans anything.
    if (!end.test(line)) state.htmlEnd = end;
    if (startsTopLevelBlock) state.inList = false;
    state.prevLineBlank = false;
    return;
  }

  if (REFERENCE_DEFINITION.test(line)) state.sawReferenceDefinition = true;

  /* Any marker indented less than 4 is a list item near the top level — the
   * regex already caps the indent at 3. `  - a` under a paragraph opens a list
   * just as `- a` does, and a later `- b` at column 0 after a blank line
   * continues THAT list rather than starting a new one. */
  if (looksLikeListItem) state.inList = true;
  else if (startsTopLevelBlock) state.inList = false;
  state.prevLineBlank = false;
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

  const state: ScanState = {
    fence: null,
    htmlEnd: null,
    lastContentIndent: 0,
    inList: false,
    prevLineBlank: true,
    sawReferenceDefinition: false,
  };

  /** Line indices a chunk may START at, in order. */
  const boundaries: number[] = [];

  /* Everything up to and including the note's own front matter belongs to the
   * first chunk (see {@link frontMatterEndLine}). */
  const frontMatterEnd = frontMatterEndLine(lines);

  for (let i = 0; i < lines.length; i += 1) {
    const bare = lines[i].replace(/\r?\n$/, '');
    const inProtectedBlock = state.fence !== null || state.htmlEnd !== null;

    /* An EMPTY line, not merely a blank one. A line of spaces reads as blank at
     * the top level but is content inside an indented code block, and whether
     * such a line ends the block is decided by what follows it — so it is not a
     * place to cut. */
    if (!inProtectedBlock && bare === '' && state.lastContentIndent < 4) {
      // Look past the whole blank run: the boundary sits before the next line
      // that actually carries content, and the blank run stays with the chunk
      // that precedes it.
      let next = i + 1;
      while (next < lines.length && isBlank(lines[next].replace(/\r?\n$/, ''))) next += 1;
      if (next < lines.length) {
        const nextLine = lines[next].replace(/\r?\n$/, '');
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
    }

    advance(state, lines[i]);
  }

  if (state.sawReferenceDefinition) return whole('reference-definition');
  if (boundaries.length === 0) return whole('no-boundary');

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
  return { chunks, chunked: true };
}

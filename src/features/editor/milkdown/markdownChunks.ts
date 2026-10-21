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

import type {
  MarkdownChunkOptions,
  ChunkDeclineReason,
  MarkdownChunkPlan,
} from './markdownChunkOptions';
import { DEFAULT_CHUNK_OPTIONS } from './markdownChunkOptions';
import type { ScanState } from './markdownChunkScan';
import { lineOffense, advance, isHardStarter } from './markdownChunkScan';
import {
  indentWidth,
  isBlank,
  LIST_MARKER,
  EMPTY_LIST_ITEM,
  definitionLabel,
  FRONT_MATTER_FENCE,
  frontMatterEndLine,
  splitKeepingLineEndings,
} from './markdownChunkLines';

export * from './markdownChunkOptions';

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

  /* Scan a copy without LEADING U+FEFFs; the parser strips exactly that one
   * (`parseNote.ts`), so line 0's front-matter fence and block structure are
   * what the scanner should see. `lines` keeps the byte for the join. */
  const scan = lines.slice();
  if (scan[0]) scan[0] = scan[0].replace(/^\ufeff+/, '');

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
    const inFrontMatter = i < frontMatterEnd;
    const offense = lineOffense(state, scan[i], inFrontMatter);
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

    if (inFrontMatter) {
      /* Not scanned as markdown; the line after it may still open a block. */
      if (i === frontMatterEnd - 1) state.prevLineBlank = false;
    } else {
      advance(state, scan[i]);
    }
  }

  if (stoppedBy) {
    /* Definitions resolve document-wide, so the tail still gets a check for
     * one — context-free, since the scanner no longer knows what is a fence. */
    let labelOpen = state.labelOpen;
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

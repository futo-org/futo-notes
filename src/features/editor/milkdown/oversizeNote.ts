/**
 * The parse cap — what the editor refuses to parse, and what it shows instead.
 *
 * `markdownChunks.ts` decides WHERE a document may be cut and `progressiveLoad.ts`
 * decides WHEN each piece reaches the editor. Neither has anything to offer a
 * note that is ONE block: there is no safe boundary inside a paragraph (cutting
 * one in two changes the document AND its serialization, which is the one thing
 * the chunk census proves is unsafe), so such a note takes a single whole-document
 * parse. This module decides when that parse is one the editor must not start.
 *
 * ## Why a cap at all
 *
 * The cost of a whole-document parse is NOT driven by the note's size. Measured
 * against the shipped bundle in chromium (2026-09-01), same 1.26 MB every row:
 *
 * | fixture                                       | initialize |
 * |---|---|
 * | 1.26 MB on ONE line (a single inline node)    |    107 ms  |
 * | 20k lines, blank line every 200               |    667 ms  |
 * | 20k lines, blank line every line              |  2,264 ms  |
 * | 20k lines, no blank line anywhere (ONE run)   |  7,796 ms  |
 *
 * and at 50k lines with no blank line, 28 s — the shape a user actually hit,
 * where the note never appeared and the iOS shell would not let them leave.
 * A CPU profile puts 63% of it inside micromark's text tokenizer: it merges
 * adjacent `data` tokens by splicing ONE events array, which is quadratic in
 * the number of tokens in a single inline content run. So the term that runs
 * away is the size of the largest RUN, and the fix has to be expressed in that
 * term rather than in bytes.
 *
 * The same measurement says which shapes are fine and must NOT be capped: at
 * 10k lines / ~640 KB a fenced code block costs 47–465 ms and a 10,000-item
 * bullet list 690 ms (each item is its own small run), while one paragraph costs
 * 2,977 ms, a blockquote of the same lines 3,204 ms and a 10,000-row table
 * 4,355 ms. {@link largestInlineRun} therefore breaks a run at anything that
 * starts a block of its own — a list marker, an ATX heading, a fence, a
 * thematic break, an HTML block — and keeps counting through the lines that
 * merely continue one.
 *
 * ## What an over-cap note gets
 *
 * A bounded prefix, mounted READ-ONLY, with a notice saying so. Read-only is
 * what makes it safe rather than merely fast: the note is never serialized, so
 * `getContent()` answers with the host's own bytes and no save can write the
 * preview over the real file. A prefix the user could edit is the one trade
 * this must not make (docs/plan/milkdown-transition.md §5) — it would put a
 * truncated document one keystroke away from disk.
 */

/** Where the cap sits, and how much of an over-cap note is shown. */
export interface OversizeNoteLimits {
  /** Lines in one inline content run past which the editor will not parse. */
  maxRunLines: number;
  /** Characters in one inline content run past which the editor will not parse. */
  maxRunChars: number;
  /** Lines of the note to mount as the read-only preview. */
  previewLines: number;
  /** Characters of the note to mount as the read-only preview. */
  previewChars: number;
}

/**
 * Both cap terms bind, because either one alone is escapable: 4,000 lines of
 * one character is cheap and 256 KB on four lines is cheap, but 4,000 lines
 * carrying 256 KB is the corner the quadratic lives in. Measured worst case
 * still under the cap — 4,000 lines × 64 chars — is 264 ms in chromium, which
 * is ~1.6 s on the low-end Android reference phone (#106 measured that engine
 * at ~6x desktop on this exact shape). Past it the numbers stop being bounded.
 *
 * The preview budget is set the same way: 400 lines × 64 KB is a handful of
 * screens for ~25 ms of parse.
 */
export const DEFAULT_OVERSIZE_LIMITS: OversizeNoteLimits = {
  maxRunLines: 4_000,
  maxRunChars: 256 * 1024,
  previewLines: 400,
  previewChars: 64 * 1024,
};

/** The largest inline content run in a document, in both cap terms. */
export interface InlineRunSize {
  lines: number;
  chars: number;
}

/** What the editor will mount for a note it refuses to parse whole. */
export interface OversizeNote {
  /** The bytes actually mounted — a prefix of the note, and never edited. */
  preview: string;
  /** Lines in the whole note. */
  totalLines: number;
  /** Lines in {@link preview}. */
  previewLines: number;
  /** The run that put the note over the cap. */
  run: InlineRunSize;
}

/** Splits into lines, each keeping its own terminator, so a join is byte-exact. */
function splitKeepingLineEndings(text: string): string[] {
  if (text === '') return [];
  return text.split(/(?<=\n)/);
}

/** Opening fence: 3+ backticks or tildes, indented at most 3, plus its info string. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * A line that opens a block of its OWN rather than continuing the one above it,
 * so the inline content run ends here and a new one begins.
 *
 * List markers and ATX headings are the two that matter: a 10,000-item list and
 * a 10,000-heading note are 10,000 small runs and parse in well under a second,
 * where the same lines as one paragraph take three. Thematic breaks and HTML
 * block starts are here for completeness — they carry no inline content at all.
 *
 * Deliberately NOT here: blockquote markers (`>`) and table rows (`|`). Both
 * feed ONE inline run — a blockquote's content is a paragraph, a GFM table's
 * body is one content chunk — and both were measured to cost the same
 * superlinear time as a bare paragraph.
 */
const STARTS_OWN_BLOCK =
  /^ {0,3}(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)|#{1,6}(?:[ \t]|$)|(?:\*[ \t]*){3,}$|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$|<)/;

/**
 * The largest run of consecutive lines that land in ONE inline content run.
 *
 * A blank line ends a run; so does a line that starts its own block
 * ({@link STARTS_OWN_BLOCK}). Lines inside a fenced code block are not inline
 * content at all — they are never inline-tokenized, which is why a 640 KB fence
 * parses in 47 ms — so a fence contributes nothing.
 *
 * A line scan with a single boolean of state: this runs on the open path for
 * every note, ahead of the parse it is deciding about, so it has to be cheap.
 */
export function largestInlineRun(markdown: string): InlineRunSize {
  let bestLines = 0;
  let bestChars = 0;
  let runLines = 0;
  let runChars = 0;
  let fence: { marker: string; length: number } | null = null;

  const keep = (): void => {
    if (runLines > bestLines) bestLines = runLines;
    if (runChars > bestChars) bestChars = runChars;
    runLines = 0;
    runChars = 0;
  };

  for (const raw of splitKeepingLineEndings(markdown)) {
    const line = raw.replace(/\r?\n$/, '');

    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`);
      if (closing.test(line)) fence = null;
      continue;
    }

    const fenceOpen = FENCE_OPEN.exec(line);
    /* A backtick fence's info string may not contain a backtick — ```` ```toml` ````
     * is a PARAGRAPH, not a code block (the same trap markdownChunks.ts's
     * scanner hit). Reading it as a fence would stop counting a run that is
     * really still open. */
    const isFence = fenceOpen !== null && !(fenceOpen[1][0] === '`' && fenceOpen[2].includes('`'));
    if (isFence) {
      keep();
      fence = { marker: fenceOpen[1][0], length: fenceOpen[1].length };
      continue;
    }

    if (line.trim() === '') {
      keep();
      continue;
    }

    if (STARTS_OWN_BLOCK.test(line)) keep();

    runLines += 1;
    runChars += raw.length;
  }
  keep();

  return { lines: bestLines, chars: bestChars };
}

/**
 * Whether `markdown` is past the parse cap, and if so what to mount for it.
 *
 * Returns `null` for every note the editor can open normally — which is every
 * note in an ordinary vault, and every large note progressive open already
 * streams. The check is deliberately independent of the chunk plan: a note the
 * planner CAN chunk still stalls on a chunk holding one enormous run, and it
 * would stall in an idle slice where nothing is watching.
 */
export function assessOversizeNote(
  markdown: string,
  limits: OversizeNoteLimits = DEFAULT_OVERSIZE_LIMITS,
): OversizeNote | null {
  const run = largestInlineRun(markdown);
  if (run.lines <= limits.maxRunLines && run.chars <= limits.maxRunChars) return null;

  const lines = splitKeepingLineEndings(markdown);
  let previewLines = 0;
  let previewChars = 0;
  while (
    previewLines < lines.length &&
    previewLines < limits.previewLines &&
    previewChars < limits.previewChars
  ) {
    previewChars += lines[previewLines].length;
    previewLines += 1;
  }

  return {
    preview: lines.slice(0, previewLines).join(''),
    totalLines: lines.length,
    previewLines,
    run,
  };
}

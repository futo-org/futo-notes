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

/**
 * Pixels one source line takes on screen, roughly: 16 px type at line-height
 * 1.55 is ~25 px, a block adds margin, and wrapped lines add more — so this
 * errs toward MORE lines in the first chunk, never a short viewport.
 */
export const ESTIMATED_LINE_PX = 24;
/** The first chunk fills the viewport plus half a screen to scroll into. */
export const FIRST_CHUNK_VIEWPORTS = 1.5;
export const FIRST_CHUNK_LINES_MIN = 30;
export const FIRST_CHUNK_LINES_MAX = 160;

/**
 * The first chunk's line budget for a viewport `viewportHeightPx` tall.
 *
 * The first chunk is the parse the user waits for, so it should be as small as
 * the screen allows and no smaller: a phone's ~800 px viewport needs ~50 lines
 * where the fixed default of 80 parsed and mounted a screen and a half it
 * could not show. Unmeasurable (no window, zero height) falls back to that
 * default, and both ends are clamped so a tiny or a 4K viewport still gets a
 * sane chunk.
 */
export function firstChunkLinesForViewport(viewportHeightPx: number | null | undefined): number {
  if (typeof viewportHeightPx !== 'number' || !Number.isFinite(viewportHeightPx)) {
    return DEFAULT_CHUNK_OPTIONS.firstChunkLines;
  }
  if (viewportHeightPx <= 0) return DEFAULT_CHUNK_OPTIONS.firstChunkLines;
  const lines = Math.ceil((viewportHeightPx / ESTIMATED_LINE_PX) * FIRST_CHUNK_VIEWPORTS);
  return Math.min(FIRST_CHUNK_LINES_MAX, Math.max(FIRST_CHUNK_LINES_MIN, lines));
}

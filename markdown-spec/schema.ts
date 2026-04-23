/**
 * FUTO Notes Markdown Spec — Test Case Schema
 *
 * Each YAML file contains an array of SpecCase objects.
 * Cases are run by both Playwright (decoration/visible text checks)
 * and Vitest (server-side tag/chunk conformance).
 */

export interface SpecCase {
  /** Unique identifier (kebab-case) */
  name: string;

  /** Complexity score (10-180). Higher = harder. Used for progressive filtering. */
  complexity: number;

  /** The raw markdown input */
  markdown: string;

  /** Cursor position for static render checks. null = editor blurred (no focus). */
  cursor?: CursorPosition | null;

  /** Starting cursor position for movement-path checks. */
  start_cursor?: CursorPosition;

  /** Keyboard moves to apply in order for movement-path checks. */
  moves?: CursorMove[];

  /** Whether the starting logical line must wrap to multiple visual rows. */
  require_wrapped_start_line?: boolean;

  /** Optional intermediate assertions after specific moves. */
  checkpoints?: CursorCheckpoint[];

  /** Expected final cursor state after all moves. */
  expect_final?: CursorExpectation;

  /** Expected outcomes for static render checks. */
  expect?: Expectations;
}

export interface CursorPosition {
  /** 0-based line number */
  line: number;
  /** 0-based character offset within the line */
  ch: number;
}

export type CursorMove =
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End';

export type CursorVerticalDirection = 'up' | 'down' | 'same';

export interface CursorExpectation {
  /** Expected 0-based line number */
  line: number;

  /** Optional expected 0-based character offset */
  ch?: number;

  /** Optional vertical movement relative to the prior step */
  vertical?: CursorVerticalDirection;

  /** Optional visible-text substring that must appear after the move. */
  visible_text_contains?: string;

  /** Optional visible-text substring that must NOT appear after the move. */
  visible_text_excludes?: string;
}

export interface CursorCheckpoint extends CursorExpectation {
  /** 1-based move index after which to assert this checkpoint */
  after: number;
}

export interface Expectations {
  /** Expected CSS class decorations in the editor DOM */
  decorations?: DecorationExpectation[];

  /** Exact visible text (innerText of .cm-content) when editor is blurred.
   *  Lines joined with newlines. Trailing whitespace is trimmed per-line. */
  visible_text?: string;

  /** Substring that must appear in visible text */
  visible_text_contains?: string;

  /** Substring that must NOT appear in visible text */
  visible_text_excludes?: string;

  /** Expected widget types present in the editor DOM */
  widgets?: WidgetExpectation[];

  /** Expected tags from extractTags() — server-side conformance */
  tags?: string[];

  /** Expected header tag block result */
  header_tag_block?: HeaderTagBlockExpectation;

  /** Expected chunk count from chunkContent() — server-side conformance */
  chunk_count?: number;
}

export interface DecorationExpectation {
  /** CSS class to look for (e.g., "cm-md-wikilink", "Decoration.replace") */
  class: string;

  /** Expected text content of the decorated element */
  text?: string;

  /** Expected count of elements with this class */
  count?: number;

  /** Expected HTML attributes on the element */
  attrs?: Record<string, string>;
}

export interface WidgetExpectation {
  /** CSS class of the widget element (e.g., "cm-md-hr-widget", "cm-md-task-checkbox") */
  class: string;

  /** Expected count */
  count?: number;
}

export interface HeaderTagBlockExpectation {
  /** Expected tags extracted from header block */
  tags: string[];

  /** Whether the header block should be hidden (endOffset > 0) */
  hidden: boolean;
}

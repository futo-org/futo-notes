/**
 * Tag parsing utilities for extracting hashtags from note content.
 *
 * Tag syntax: #[a-z][a-z0-9_-]* (max 50 chars after #)
 * - Must start with a letter after #
 * - Canonical names are lowercase; user-entered whitespace normalizes to _
 * - Preceded by whitespace or start of line
 * - Not inside code blocks/fences or inline code
 *
 * This is a DELIBERATE TS copy of the canonical Rust rule
 * (`crates/futo-notes-model/src/tags.rs`), kept in lockstep via
 * `tests/conformance/tags.json`. The copy exists so the editor's per-keystroke
 * paths (live tag decorations, the header tag bar) compute synchronously in the
 * webview without an async IPC/FFI round-trip to Rust on every keystroke — a
 * hop that would lag decorations a frame behind the cursor. The note-list scan,
 * by contrast, runs in Rust (no copy needed). Tradeoff accepted; the catch is
 * conformance locks *behavior*, NOT performance.
 *
 * INVARIANT: tag matching MUST be linear (`scanTags`), never a backtracking
 * regex over note content. `TAG_REGEX` below is the canonical *spec* of the
 * rule, but executing it via the (backtracking) JS engine over a large note
 * catastrophically backtracks — a ~900 KB note hung the scan for minutes. So
 * production code scans with `scanTags`; `TAG_REGEX` is documentation + a
 * small-input test reference only. The Rust side has the identical invariant.
 */

/** Maximum length of a tag name (after the #) */
export const MAX_TAG_LENGTH = 50;

/**
 * Regex for matching a single tag.
 * Uses lookbehind for whitespace-or-start and captures the full #tag.
 */
export const TAG_REGEX = /(?:^|(?<=\s))#([a-zA-Z][a-zA-Z0-9_-]{0,49})(?=$|\s|[.,;:!?)}\]])/gm;

/**
 * Test if a single string (without #) is a valid tag name.
 */
export function isValidTagName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_TAG_LENGTH) return false;
  return /^[a-z][a-z0-9_-]*$/.test(name);
}

/**
 * Normalize user-entered tag text to the canonical on-disk name.
 *
 * Examples:
 * - "Whale" -> "whale"
 * - "dog problems" -> "dog_problems"
 */
export function normalizeTagName(name: string): string {
  return name
    .trim()
    .replace(/^#+/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

/**
 * Strip regions that are inside fenced code blocks (``` or ~~~) or inline code (`).
 * Returns content with those regions replaced by spaces (to preserve offsets).
 */
function stripCodeRegions(content: string): string {
  const chars = content.split('');

  // First pass: fenced code blocks (``` or ~~~)
  const fenceRe = /^( {0,3})(```+|~~~+)(.*)$/gm;
  let match: RegExpExecArray | null;
  const fences: Array<{ start: number; end: number }> = [];
  const openFences: Array<{ pos: number; marker: string }> = [];

  // Find all fence lines
  const fenceLines: Array<{ index: number; indent: string; marker: string; rest: string }> = [];
  while ((match = fenceRe.exec(content)) !== null) {
    fenceLines.push({
      index: match.index,
      indent: match[1],
      marker: match[2],
      rest: match[3],
    });
  }

  for (const fence of fenceLines) {
    const baseChar = fence.marker[0];
    const len = fence.marker.length;

    if (openFences.length > 0) {
      const open = openFences[openFences.length - 1];
      const openChar = open.marker[0];
      const openLen = open.marker.length;
      // Closing fence must use same char and be at least as long
      if (baseChar === openChar && len >= openLen && fence.rest.trim() === '') {
        fences.push({ start: open.pos, end: fence.index + fence.marker.length + fence.indent.length + fence.rest.length });
        openFences.pop();
        continue;
      }
    }

    // Opening fence
    openFences.push({ pos: fence.index, marker: fence.marker });
  }

  // Unclosed fences extend to end of document
  for (const open of openFences) {
    fences.push({ start: open.pos, end: content.length });
  }

  // Blank out fenced regions
  for (const { start, end } of fences) {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }

  // Second pass: inline code (backticks)
  const result = chars.join('');
  return result.replace(/(`+)([^`]*?)\1/g, (m) => {
    return m.replace(/[^\n]/g, ' ');
  });
}

/** A `TAG_REGEX` match: the captured name (group 1) and its byte offsets in the
 * source. `start` points at the `#`; `end` is just past the name. */
export interface TagMatch {
  /** Offset of the `#`. */
  start: number;
  /** Offset just past the last name char (exclusive). */
  end: number;
  /** Captured name WITHOUT the `#` (regex group 1). */
  name: string;
}

const TAG_TERMINATORS = new Set(['.', ',', ';', ':', '!', '?', ')', '}', ']']);

function isTagNameCode(code: number): boolean {
  // [A-Za-z0-9_-]
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f || // _
    code === 0x2d // -
  );
}

function isAsciiAlphaCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/**
 * Find every `TAG_REGEX` match — name + position — in document order. This is a
 * LINEAR hand-scan, NOT a regex. It is byte-for-byte equivalent to `TAG_REGEX`
 * (locked by the `tagRegexMatches`/`extractTags` conformance fixtures) and the
 * matching Rust `tag_regex_matches` (crates/futo-notes-model/src/tags.rs), but
 * O(n): it cannot catastrophically backtrack.
 *
 * `TAG_REGEX` needs a lookbehind, which only a *backtracking* engine
 * (`fancy-regex` in Rust, the JS engine here) supports — and on a large note
 * that backtracking pegged a core for minutes (the note scan never finished,
 * the list stayed empty). The pattern admits no *real* backtracking, though:
 * the name class `[A-Za-z0-9_-]` is disjoint from the terminator set (`\s` and
 * `[.,;:!?)}\]]`), so the greedy `{0,49}` can only satisfy the look-ahead at the
 * natural end of the name run. So we scan it directly. A match requires, at a
 * `#`: (1) left boundary — start-of-string or the preceding char is `\s`
 * (`(?m)^` after a newline is subsumed); (2) a name `[A-Za-z][A-Za-z0-9_-]{0,49}`
 * (1..=50 chars); (3) right boundary — EOS / `\s` / a terminator (zero-width).
 * `\s` is tested with `/\s/` so it matches the JS regex's `\s` exactly.
 */
export function scanTags(content: string): TagMatch[] {
  const out: TagMatch[] = [];
  const n = content.length;
  let i = 0;
  while (i < n) {
    if (content.charCodeAt(i) !== 0x23 /* # */) {
      i++;
      continue;
    }
    // (1) left boundary: start-of-string or preceded by a whitespace char.
    if (!(i === 0 || /\s/.test(content[i - 1]))) {
      i++;
      continue;
    }
    // (2) name: first char [A-Za-z], then up to 49 of [A-Za-z0-9_-].
    const nameStart = i + 1;
    if (nameStart >= n || !isAsciiAlphaCode(content.charCodeAt(nameStart))) {
      i++;
      continue;
    }
    let j = nameStart + 1;
    while (j < n && isTagNameCode(content.charCodeAt(j))) j++;
    // (3) length 1..=50 AND right boundary is EOS / \s / terminator punct.
    if (j - nameStart <= MAX_TAG_LENGTH && (j >= n || /\s/.test(content[j]) || TAG_TERMINATORS.has(content[j]))) {
      out.push({ start: i, end: j, name: content.slice(nameStart, j) });
    }
    // No `#` lives inside a name run, and the `#` at `i` is handled, so resuming
    // at `j` (always > `i`) skips no candidate — the zero-width look-ahead isn't
    // consumed, so this is exactly where the regex would resume.
    i = j;
  }
  return out;
}

/**
 * Raw `TAG_REGEX` capture-group-1 values (names without `#`) in document order,
 * with duplicates (callers dedup). The linear equivalent of iterating
 * `TAG_REGEX` — exposed for conformance and reused by the editor's tag
 * decorations.
 */
export function tagRegexMatches(content: string): string[] {
  return scanTags(content).map((m) => m.name);
}

/**
 * Extract all unique tags from note content, excluding tags inside code blocks/fences.
 * Returns canonical tags with the # prefix.
 */
export function extractTags(content: string): string[] {
  const cleaned = stripCodeRegions(content);
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const { name } of scanTags(cleaned)) {
    const tag = '#' + normalizeTagName(name);
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }

  return tags;
}

/** Regex for a line that consists only of tags and whitespace */
const TAG_LINE_RE = /^\s*#[a-zA-Z][a-zA-Z0-9_-]{0,49}(\s+#[a-zA-Z][a-zA-Z0-9_-]{0,49})*\s*$/;

/**
 * Extract the "header tag block" — a contiguous run of lines at the very start
 * of the note where each line consists only of hashtags and whitespace.
 *
 * Returns the tags found and the byte offset where the block ends
 * (including any trailing blank line separator).
 */
export function extractHeaderTagBlock(content: string): { tags: string[]; endOffset: number } {
  // Walk lines via `indexOf('\n')` rather than `content.split('\n')`.
  // The previous split allocated one String per line of the *entire*
  // note even when the tag block is the first few lines — `NoteTagBar`
  // reads this on every keystroke, so the old O(doc-length) allocation
  // was paid per frame.
  const tags: string[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let cursor = 0;
  const len = content.length;

  while (cursor <= len) {
    const nlIdx = content.indexOf('\n', cursor);
    const lineEnd = nlIdx === -1 ? len : nlIdx;
    const line = content.slice(cursor, lineEnd);
    if (!TAG_LINE_RE.test(line)) break;
    for (const { name } of scanTags(line)) {
      const tag = '#' + normalizeTagName(name);
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
    offset = nlIdx === -1 ? len : nlIdx + 1;
    if (nlIdx === -1) break;
    cursor = offset;
  }

  if (offset === 0) {
    return { tags: [], endOffset: 0 };
  }

  // Include a trailing blank line if present (the block is conceptually
  // terminated by an empty line separator, not by a content line).
  if (offset < len) {
    const nextNl = content.indexOf('\n', offset);
    const trailEnd = nextNl === -1 ? len : nextNl;
    let onlyBlank = true;
    for (let i = offset; i < trailEnd; i++) {
      const ch = content.charCodeAt(i);
      if (ch !== 0x20 && ch !== 0x09 && ch !== 0x0d) {
        onlyBlank = false;
        break;
      }
    }
    if (onlyBlank) {
      offset = nextNl === -1 ? len : nextNl + 1;
    }
  }

  if (offset > len) offset = len;
  return { tags, endOffset: offset };
}

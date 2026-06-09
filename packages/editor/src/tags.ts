/**
 * Tag parsing utilities for extracting hashtags from note content.
 *
 * Tag syntax: #[a-z][a-z0-9_-]* (max 50 chars after #)
 * - Must start with a letter after #
 * - Canonical names are lowercase; user-entered whitespace normalizes to _
 * - Preceded by whitespace or start of line
 * - Not inside code blocks/fences or inline code
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

/**
 * Extract all unique tags from note content, excluding tags inside code blocks/fences.
 * Returns canonical tags with the # prefix.
 */
export function extractTags(content: string): string[] {
  const cleaned = stripCodeRegions(content);
  const seen = new Set<string>();
  const tags: string[] = [];
  const re = new RegExp(TAG_REGEX.source, TAG_REGEX.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(cleaned)) !== null) {
    const tag = '#' + normalizeTagName(match[1]);
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
  const tagRe = new RegExp(TAG_REGEX.source, TAG_REGEX.flags);

  while (cursor <= len) {
    const nlIdx = content.indexOf('\n', cursor);
    const lineEnd = nlIdx === -1 ? len : nlIdx;
    const line = content.slice(cursor, lineEnd);
    if (!TAG_LINE_RE.test(line)) break;
    tagRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(line)) !== null) {
      const tag = '#' + normalizeTagName(match[1]);
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

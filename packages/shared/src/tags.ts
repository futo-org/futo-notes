/**
 * Tag parsing utilities for extracting hashtags from note content.
 *
 * Tag syntax: #[a-zA-Z][a-zA-Z0-9_-]* (max 50 chars after #)
 * - Must start with a letter after #
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
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name);
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
 * Returns tags with the # prefix, preserving original casing.
 * Deduplicated case-insensitively (first occurrence wins).
 */
export function extractTags(content: string): string[] {
  const cleaned = stripCodeRegions(content);
  const seen = new Map<string, string>(); // lowercase → original
  const re = new RegExp(TAG_REGEX.source, TAG_REGEX.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(cleaned)) !== null) {
    const tag = '#' + match[1];
    const lower = tag.toLowerCase();
    if (!seen.has(lower)) {
      seen.set(lower, tag);
    }
  }

  return Array.from(seen.values());
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
  const lines = content.split('\n');
  const tags: string[] = [];
  const seen = new Set<string>();
  let endLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TAG_LINE_RE.test(line)) {
      // Extract tags from this line
      const re = new RegExp(TAG_REGEX.source, TAG_REGEX.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(line)) !== null) {
        const tag = '#' + match[1];
        const lower = tag.toLowerCase();
        if (!seen.has(lower)) {
          seen.add(lower);
          tags.push(tag);
        }
      }
      endLine = i + 1;
    } else {
      break;
    }
  }

  if (endLine === 0) {
    return { tags: [], endOffset: 0 };
  }

  // Calculate byte offset: sum of all tag lines + their newlines
  let offset = 0;
  for (let i = 0; i < endLine; i++) {
    offset += lines[i].length + 1; // +1 for \n
  }

  // Include trailing blank line if present
  if (endLine < lines.length && lines[endLine].trim() === '') {
    offset += lines[endLine].length + 1;
  }

  // Don't exceed content length (handles missing final newline)
  if (offset > content.length) {
    offset = content.length;
  }

  return { tags, endOffset: offset };
}

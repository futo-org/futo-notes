export interface Chunk {
  text: string;
  startOffset: number;
  endOffset: number;
}

/**
 * Approximate token count: words * 1.3
 */
export function estimateTokens(text: string): number {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(wordCount * 1.3);
}

const TARGET_TOKENS = 900;
const OVERLAP_RATIO = 0.15;
const SHORT_NOTE_THRESHOLD = 512;

/**
 * Split markdown content into chunks at heading and paragraph boundaries.
 * - Target ~900 tokens per chunk with 15% overlap
 * - Short notes (<512 tokens) become a single chunk
 * - Returns chunks with their byte offsets
 */
const MIN_WORDS = 10;

export function chunkContent(content: string): Chunk[] {
  if (!content.trim()) return [];

  if (content.split(/\s+/).filter(Boolean).length < MIN_WORDS) return [];

  // Short notes: single chunk
  if (estimateTokens(content) < SHORT_NOTE_THRESHOLD) {
    return [{ text: content, startOffset: 0, endOffset: content.length }];
  }

  // Split at heading and paragraph boundaries
  const sections = splitAtBoundaries(content);

  // Merge small sections into target-sized chunks with overlap
  return mergeWithOverlap(sections);
}

interface Section {
  text: string;
  startOffset: number;
  endOffset: number;
}

/**
 * Split content at heading (# ...) and paragraph (double newline) boundaries.
 */
function splitAtBoundaries(content: string): Section[] {
  const sections: Section[] = [];
  // Split on headings or double newlines
  const pattern = /(?=^#{1,6}\s)/m;
  const paragraphPattern = /\n\n+/;

  // First split on headings
  const headingSplits: Section[] = [];
  let offset = 0;
  const parts = content.split(pattern);

  for (const part of parts) {
    if (part.length > 0) {
      headingSplits.push({
        text: part,
        startOffset: offset,
        endOffset: offset + part.length,
      });
    }
    offset += part.length;
  }

  // Then split large sections on paragraphs, then by word count as fallback
  for (const section of headingSplits) {
    if (estimateTokens(section.text) <= TARGET_TOKENS) {
      sections.push(section);
      continue;
    }

    // Split on double newlines
    let innerOffset = section.startOffset;
    const paraParts = section.text.split(paragraphPattern);
    const paraSections: Section[] = [];

    for (let i = 0; i < paraParts.length; i++) {
      const para = paraParts[i];
      if (para.length > 0) {
        const actualStart = content.indexOf(para, innerOffset);
        const start = actualStart >= 0 ? actualStart : innerOffset;
        paraSections.push({
          text: para,
          startOffset: start,
          endOffset: start + para.length,
        });
      }
      innerOffset += para.length;
      if (i < paraParts.length - 1) {
        const nextStart = content.indexOf(paraParts[i + 1], innerOffset);
        if (nextStart > innerOffset) {
          innerOffset = nextStart;
        }
      }
    }

    // Further split any oversized paragraph sections by word count
    for (const ps of paraSections) {
      if (estimateTokens(ps.text) <= TARGET_TOKENS) {
        sections.push(ps);
      } else {
        sections.push(...splitByWordCount(ps));
      }
    }
  }

  return sections;
}

/**
 * Split an oversized section by word count when no structural boundaries exist.
 */
function splitByWordCount(section: Section): Section[] {
  const words = section.text.split(/(\s+)/); // preserve whitespace
  const targetWords = Math.floor(TARGET_TOKENS / 1.3);
  const results: Section[] = [];

  let currentWords: string[] = [];
  let wordCount = 0;
  let currentOffset = section.startOffset;

  for (const token of words) {
    currentWords.push(token);
    if (token.trim()) wordCount++;

    if (wordCount >= targetWords) {
      const text = currentWords.join('');
      results.push({
        text,
        startOffset: currentOffset,
        endOffset: currentOffset + text.length,
      });
      currentOffset += text.length;
      currentWords = [];
      wordCount = 0;
    }
  }

  if (currentWords.length > 0) {
    const text = currentWords.join('');
    if (text.trim()) {
      results.push({
        text,
        startOffset: currentOffset,
        endOffset: currentOffset + text.length,
      });
    }
  }

  return results;
}

/**
 * Merge sections into target-sized chunks with overlap.
 */
function mergeWithOverlap(sections: Section[]): Chunk[] {
  if (sections.length === 0) return [];

  const chunks: Chunk[] = [];
  let currentText = '';
  let currentStart = sections[0].startOffset;
  let currentEnd = sections[0].endOffset;

  for (const section of sections) {
    const combinedTokens = estimateTokens(currentText + '\n\n' + section.text);

    if (currentText && combinedTokens > TARGET_TOKENS) {
      // Emit current chunk
      chunks.push({
        text: currentText,
        startOffset: currentStart,
        endOffset: currentEnd,
      });

      // Start new chunk with overlap from the end of the previous chunk
      const overlapTokens = Math.floor(TARGET_TOKENS * OVERLAP_RATIO);
      const overlap = getOverlapText(currentText, overlapTokens);
      if (overlap) {
        currentText = overlap + '\n\n' + section.text;
        currentStart = currentEnd - overlap.length;
      } else {
        currentText = section.text;
        currentStart = section.startOffset;
      }
      currentEnd = section.endOffset;
    } else if (!currentText) {
      currentText = section.text;
      currentStart = section.startOffset;
      currentEnd = section.endOffset;
    } else {
      currentText += '\n\n' + section.text;
      currentEnd = section.endOffset;
    }
  }

  // Emit final chunk
  if (currentText) {
    chunks.push({
      text: currentText,
      startOffset: currentStart,
      endOffset: currentEnd,
    });
  }

  return chunks;
}

/**
 * Get the last N approximate tokens from text for overlap.
 */
function getOverlapText(text: string, targetTokens: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = Math.floor(targetTokens / 1.3);
  if (wordCount >= words.length) return text;
  return words.slice(-wordCount).join(' ');
}

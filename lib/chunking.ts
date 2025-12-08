/**
 * Text chunking utilities for semantic search indexing.
 */

export interface Chunk {
  text: string;
  startOffset: number;
  endOffset: number;
  isTitle?: boolean;
}

const MIN_CHUNK_LENGTH = 10;
const MIN_TITLE_LENGTH = 2;
const MAX_CHUNK_LENGTH = 500; // Keep chunks small enough for embedding model

/**
 * Split a large text into smaller chunks at sentence boundaries.
 */
function splitLargeChunk(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const result: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      result.push(remaining);
      break;
    }

    // Try to split at sentence boundary (. ! ?)
    let splitIndex = -1;
    for (let i = maxLength; i > maxLength / 2; i--) {
      const char = remaining[i];
      if ((char === '.' || char === '!' || char === '?') &&
          (i + 1 >= remaining.length || remaining[i + 1] === ' ' || remaining[i + 1] === '\n')) {
        splitIndex = i + 1;
        break;
      }
    }

    // If no sentence boundary, try to split at word boundary
    if (splitIndex === -1) {
      for (let i = maxLength; i > maxLength / 2; i--) {
        if (remaining[i] === ' ' || remaining[i] === '\n') {
          splitIndex = i;
          break;
        }
      }
    }

    // Last resort: hard split
    if (splitIndex === -1) {
      splitIndex = maxLength;
    }

    result.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  return result.filter(s => s.length >= MIN_CHUNK_LENGTH);
}

/**
 * Split note content into chunks by paragraphs (double newlines).
 * Includes the title as a separate chunk for better keyword matching.
 * Filters out empty and very short chunks.
 * Large chunks are split at sentence boundaries.
 */
export function chunkByParagraphs(content: string): Chunk[] {
  const chunks: Chunk[] = [];

  const firstNewline = content.indexOf("\n");

  // Extract and index the title (first line)
  const title = firstNewline === -1 ? content : content.slice(0, firstNewline);
  const trimmedTitle = title.trim();

  if (trimmedTitle.length >= MIN_TITLE_LENGTH) {
    chunks.push({
      text: trimmedTitle,
      startOffset: 0,
      endOffset: title.length,
      isTitle: true,
    });
  }

  if (firstNewline === -1) {
    // Note is just a title
    return chunks;
  }

  const bodyContent = content.slice(firstNewline + 1);
  const bodyOffset = firstNewline + 1;

  // Split on double newlines (paragraph breaks)
  const paragraphs = bodyContent.split(/\n\n+/);

  let currentOffset = 0;
  for (const para of paragraphs) {
    const trimmed = para.trim();

    if (trimmed.length >= MIN_CHUNK_LENGTH) {
      // Find the actual position in bodyContent
      const paraStart = bodyContent.indexOf(para, currentOffset);
      const startOffset = bodyOffset + paraStart;

      // Split large paragraphs into smaller chunks
      const subChunks = splitLargeChunk(trimmed, MAX_CHUNK_LENGTH);

      let subOffset = startOffset;
      for (const subChunk of subChunks) {
        chunks.push({
          text: subChunk,
          startOffset: subOffset,
          endOffset: subOffset + subChunk.length,
        });
        subOffset += subChunk.length + 1; // +1 for the space/newline removed
      }
    }

    // Move past this paragraph for the next search
    currentOffset = bodyContent.indexOf(para, currentOffset) + para.length;
  }

  return chunks;
}

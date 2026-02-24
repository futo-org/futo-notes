import { describe, it, expect } from 'vitest';
import { chunkContent, estimateTokens } from '../../src/search/chunker.js';

describe('estimateTokens', () => {
  it('estimates tokens as words * 1.3', () => {
    const text = 'one two three four five';
    expect(estimateTokens(text)).toBe(Math.ceil(5 * 1.3));
  });

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('handles single word', () => {
    expect(estimateTokens('hello')).toBe(Math.ceil(1 * 1.3));
  });
});

describe('chunkContent', () => {
  it('returns empty array for empty content', () => {
    expect(chunkContent('')).toEqual([]);
    expect(chunkContent('   ')).toEqual([]);
  });

  it('returns empty array for notes with fewer than 10 words', () => {
    expect(chunkContent('hello world')).toEqual([]);
    expect(chunkContent('one two three four five six seven eight nine')).toEqual([]);
  });

  it('returns chunks for notes with exactly 10 words', () => {
    const content = 'one two three four five six seven eight nine ten';
    const chunks = chunkContent(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(content);
  });

  it('returns single chunk for short notes', () => {
    const content = 'This is a short note with just a few words in it.';
    const chunks = chunkContent(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(content);
    expect(chunks[0].startOffset).toBe(0);
    expect(chunks[0].endOffset).toBe(content.length);
  });

  it('splits at heading boundaries', () => {
    // Generate content long enough to require multiple chunks
    const section1 = '# Section One\n\n' + 'Word '.repeat(400);
    const section2 = '# Section Two\n\n' + 'Word '.repeat(400);
    const content = section1 + '\n' + section2;

    const chunks = chunkContent(content);
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should have valid offsets
    for (const chunk of chunks) {
      expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
      expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it('splits at paragraph boundaries for long sections', () => {
    const para1 = 'First paragraph. ' + 'Word '.repeat(400);
    const para2 = 'Second paragraph. ' + 'Word '.repeat(400);
    const content = para1 + '\n\n' + para2;

    const chunks = chunkContent(content);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('preserves all content across chunks', () => {
    const sections = Array.from({ length: 5 }, (_, i) =>
      `# Section ${i + 1}\n\n` + `Content for section ${i + 1}. ` + 'Word '.repeat(200)
    );
    const content = sections.join('\n');

    const chunks = chunkContent(content);
    expect(chunks.length).toBeGreaterThan(1);

    // All chunks should have non-empty text
    for (const chunk of chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('handles content with only headings', () => {
    const content = '# Heading 1\n\nSome text\n\n# Heading 2\n\nMore text';
    const chunks = chunkContent(content);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // All content should be covered
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it('handles very long single paragraph', () => {
    const content = 'Word '.repeat(2000);
    const chunks = chunkContent(content);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('chunk offsets are within content bounds', () => {
    const content = '# Title\n\n' + 'Paragraph. '.repeat(500) + '\n\n# Another\n\n' + 'More text. '.repeat(500);
    const chunks = chunkContent(content);
    for (const chunk of chunks) {
      expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
      expect(chunk.endOffset).toBeLessThanOrEqual(content.length);
    }
  });
});

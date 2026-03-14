import { describe, expect, it } from 'vitest';
import { buildEmbeddingText, titleFromFilename } from '../../src/search/embeddingIndexer.js';

describe('embeddingIndexer helpers', () => {
  it('derives the note title directly from the filename', () => {
    expect(titleFromFilename('Gift ideas.md')).toBe('Gift ideas');
    expect(titleFromFilename('Project Plan.MD')).toBe('Project Plan');
  });

  it('prefixes each embedded chunk with the note title', () => {
    expect(buildEmbeddingText('Gift ideas.md', '- Darn tough socks')).toBe(
      'Title: Gift ideas\n\n- Darn tough socks',
    );
  });
});

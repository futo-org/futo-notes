import { describe, it, expect } from 'vitest';
import {
  TAG_REGEX,
  isValidTagName,
  extractTags,
  extractHeaderTagBlock,
} from './tags.js';

describe('TAG_REGEX', () => {
  it('matches basic tags', () => {
    const text = '#recipes #cooking';
    const matches = [...text.matchAll(new RegExp(TAG_REGEX.source, TAG_REGEX.flags))];
    expect(matches.map((m) => m[1])).toEqual(['recipes', 'cooking']);
  });

  it('requires letter after #', () => {
    const text = '#123 #a1 #Z';
    const matches = [...text.matchAll(new RegExp(TAG_REGEX.source, TAG_REGEX.flags))];
    expect(matches.map((m) => m[1])).toEqual(['a1', 'Z']);
  });

  it('allows hyphens and underscores', () => {
    const text = '#meal-prep #to_do';
    const matches = [...text.matchAll(new RegExp(TAG_REGEX.source, TAG_REGEX.flags))];
    expect(matches.map((m) => m[1])).toEqual(['meal-prep', 'to_do']);
  });

  it('does not match ATX headings', () => {
    const text = '# heading\n## heading2';
    const matches = [...text.matchAll(new RegExp(TAG_REGEX.source, TAG_REGEX.flags))];
    expect(matches).toHaveLength(0);
  });

  it('matches tags at start of line', () => {
    const text = '#tag\n#another';
    const matches = [...text.matchAll(new RegExp(TAG_REGEX.source, TAG_REGEX.flags))];
    expect(matches.map((m) => m[1])).toEqual(['tag', 'another']);
  });

  it('does not match mid-word #tags', () => {
    const text = 'example.com#section foo#bar';
    const matches = [...text.matchAll(new RegExp(TAG_REGEX.source, TAG_REGEX.flags))];
    expect(matches).toHaveLength(0);
  });
});

describe('isValidTagName', () => {
  it('accepts valid names', () => {
    expect(isValidTagName('recipes')).toBe(true);
    expect(isValidTagName('meal-prep')).toBe(true);
    expect(isValidTagName('to_do')).toBe(true);
    expect(isValidTagName('React')).toBe(true);
    expect(isValidTagName('a')).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(isValidTagName('')).toBe(false);
    expect(isValidTagName('123')).toBe(false);
    expect(isValidTagName('-start')).toBe(false);
    expect(isValidTagName('_start')).toBe(false);
    expect(isValidTagName('a'.repeat(51))).toBe(false);
  });
});

describe('extractTags', () => {
  it('extracts tags from simple content', () => {
    const content = '#recipes #cooking\n\nSome note about food.';
    expect(extractTags(content)).toEqual(['#recipes', '#cooking']);
  });

  it('extracts inline tags', () => {
    const content = 'Check out this #recipe for #healthy eating.';
    expect(extractTags(content)).toEqual(['#recipe', '#healthy']);
  });

  it('deduplicates case-insensitively (first wins)', () => {
    const content = '#Recipe #recipe #RECIPE';
    expect(extractTags(content)).toEqual(['#Recipe']);
  });

  it('skips tags inside fenced code blocks', () => {
    const content = '#real\n\n```\n#fake\n```\n\n#also-real';
    expect(extractTags(content)).toEqual(['#real', '#also-real']);
  });

  it('skips tags inside tilde fenced code blocks', () => {
    const content = '#real\n\n~~~\n#fake\n~~~\n\n#also-real';
    expect(extractTags(content)).toEqual(['#real', '#also-real']);
  });

  it('skips tags inside inline code', () => {
    const content = 'Use `#notATag` but #realTag is fine';
    expect(extractTags(content)).toEqual(['#realTag']);
  });

  it('does not match headings', () => {
    const content = '# Heading\n## Another\n\n#tag';
    expect(extractTags(content)).toEqual(['#tag']);
  });

  it('returns empty array for no tags', () => {
    expect(extractTags('Just some text')).toEqual([]);
    expect(extractTags('')).toEqual([]);
  });

  it('handles unclosed code fence', () => {
    const content = '#before\n```\n#inside';
    expect(extractTags(content)).toEqual(['#before']);
  });

  it('handles tags with punctuation after them', () => {
    const content = '#tag1, #tag2. #tag3! #tag4?';
    expect(extractTags(content)).toEqual(['#tag1', '#tag2', '#tag3', '#tag4']);
  });
});

describe('extractHeaderTagBlock', () => {
  it('extracts header tags at start of note', () => {
    const content = '#recipes #cooking\n#healthy\n\nThis is the note content';
    const result = extractHeaderTagBlock(content);
    expect(result.tags).toEqual(['#recipes', '#cooking', '#healthy']);
    expect(content.slice(result.endOffset)).toBe('This is the note content');
  });

  it('returns empty for no header tags', () => {
    const content = 'This is a note\n#inline-tag';
    const result = extractHeaderTagBlock(content);
    expect(result.tags).toEqual([]);
    expect(result.endOffset).toBe(0);
  });

  it('stops at non-tag line', () => {
    const content = '#recipes some text\nMore content';
    const result = extractHeaderTagBlock(content);
    expect(result.tags).toEqual([]);
    expect(result.endOffset).toBe(0);
  });

  it('includes trailing blank line in offset', () => {
    const content = '#tag\n\nContent here';
    const result = extractHeaderTagBlock(content);
    expect(result.tags).toEqual(['#tag']);
    // '#tag\n' = 5 chars, then blank line '\n' = 1 char = offset 6
    expect(result.endOffset).toBe(6);
    expect(content.slice(result.endOffset)).toBe('Content here');
  });

  it('handles tag block at end of document', () => {
    const content = '#only-tags\n#here';
    const result = extractHeaderTagBlock(content);
    expect(result.tags).toEqual(['#only-tags', '#here']);
    expect(result.endOffset).toBe(content.length);
  });

  it('deduplicates header tags case-insensitively', () => {
    const content = '#Tag #tag\n\nContent';
    const result = extractHeaderTagBlock(content);
    expect(result.tags).toEqual(['#Tag']);
  });

  it('handles multiple tag lines', () => {
    const content = '#a #b\n#c\n#d\n\nContent';
    const result = extractHeaderTagBlock(content);
    expect(result.tags).toEqual(['#a', '#b', '#c', '#d']);
    expect(content.slice(result.endOffset)).toBe('Content');
  });
});

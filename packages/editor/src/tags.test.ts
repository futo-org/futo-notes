import { describe, it, expect } from 'vitest';
import {
  TAG_REGEX,
  isValidTagName,
  normalizeTagName,
  extractTags,
  extractHeaderTagBlock,
  scanTags,
  tagRegexMatches,
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
    expect(isValidTagName('a')).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(isValidTagName('')).toBe(false);
    expect(isValidTagName('123')).toBe(false);
    expect(isValidTagName('-start')).toBe(false);
    expect(isValidTagName('_start')).toBe(false);
    expect(isValidTagName('React')).toBe(false);
    expect(isValidTagName('dog problems')).toBe(false);
    expect(isValidTagName('a'.repeat(51))).toBe(false);
  });
});

describe('normalizeTagName', () => {
  it('lowercases tags and replaces whitespace with underscores', () => {
    expect(normalizeTagName('Whale')).toBe('whale');
    expect(normalizeTagName('dog problems')).toBe('dog_problems');
    expect(normalizeTagName('#Dog   Problems')).toBe('dog_problems');
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

  it('normalizes and deduplicates case-insensitively', () => {
    const content = '#Recipe #recipe #RECIPE';
    expect(extractTags(content)).toEqual(['#recipe']);
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
    expect(extractTags(content)).toEqual(['#realtag']);
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
    expect(result.tags).toEqual(['#tag']);
  });

  it('handles multiple tag lines', () => {
    const content = '#a #b\n#c\n#d\n\nContent';
    const result = extractHeaderTagBlock(content);
    expect(result.tags).toEqual(['#a', '#b', '#c', '#d']);
    expect(content.slice(result.endOffset)).toBe('Content');
  });
});

describe('scanTags (linear) — parity with TAG_REGEX + ReDoS safety', () => {
  // The linear scanner must be byte-for-byte equivalent to the (backtracking)
  // TAG_REGEX. Run BOTH over a corpus of tricky inputs and assert identical
  // captures, so the perf rewrite can never silently change behavior.
  const corpus = [
    '#recipes #cooking',
    '#a #b', // adjacency — zero-width boundaries, both must match
    'word#tag', // not preceded by whitespace → no match
    '##tag',
    '#tag.', '#tag,', '(#tag)', '#tag!', '#tag?', '#tag]', '#tag}',
    '#tag@x', '#tag/x', // non-terminator after the name → no match
    '#a-b_c1 ',
    '#1tag #-tag #_tag', // first char after # must be a letter
    'line1\n#tag\nline3', // (?m)^ after a newline
    'a #tag b', // U+00A0 is \s on both sides
    '#' + 'a'.repeat(50), // 50-char cap → matches
    '#' + 'a'.repeat(51) + ' ', // 51 name chars → no match
    'see #one, #two; and #three.',
  ];
  for (const input of corpus) {
    it(`matches TAG_REGEX for ${JSON.stringify(input).slice(0, 36)}`, () => {
      const viaRegex = [...input.matchAll(new RegExp(TAG_REGEX.source, TAG_REGEX.flags))].map(
        (m) => m[1],
      );
      expect(tagRegexMatches(input)).toEqual(viaRegex);
    });
  }

  it('reports correct match positions', () => {
    expect(scanTags('xx #tag yy')).toEqual([{ start: 3, end: 7, name: 'tag' }]);
  });

  // Regression: a ~1 MB note must extract in well under a second. Executing the
  // backtracking TAG_REGEX over content like this pegged a core for MINUTES (it
  // hung the note scan, leaving the list empty). Linear scan ⇒ a few ms.
  it('extracts a ~1 MB note fast (no catastrophic backtracking)', () => {
    const block =
      '### A Heading With Words\n\nSome prose, with punctuation; ' +
      'and the #realtag here. More text: see section #3 and item #b? Yes.\n\n';
    const big = block.repeat(10_000); // ~1.2 MB
    expect(big.length).toBeGreaterThan(1_000_000);
    const t = performance.now();
    const tags = extractTags(big);
    const ms = performance.now() - t;
    expect(tags).toContain('#realtag');
    expect(ms).toBeLessThan(3000);
  });
});

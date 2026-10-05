import { describe, it, expect } from 'vitest';
import { TAG_REGEX, extractTags, scanTags, tagRegexMatches } from './tags.js';

// Input/output cases for isValidTagName, normalizeTagName, extractTags,
// extractHeaderTagBlock and tagRegexMatches live in the hand-reviewed golden
// tests/conformance/tags.json (run by conformance.test.ts and the Rust model
// crate). This file keeps the TAG_REGEX parity corpus and the ReDoS guard.

describe('scanTags (linear) — parity with TAG_REGEX + ReDoS safety', () => {
  // The linear scanner must be byte-for-byte equivalent to the (backtracking)
  // TAG_REGEX. Run BOTH over a corpus of tricky inputs and assert identical
  // captures, so the perf rewrite can never silently change behavior.
  const corpus = [
    '#recipes #cooking',
    '#a #b', // adjacency — zero-width boundaries, both must match
    'word#tag', // not preceded by whitespace → no match
    '##tag',
    '#tag.',
    '#tag,',
    '(#tag)',
    '#tag!',
    '#tag?',
    '#tag]',
    '#tag}',
    '#tag@x',
    '#tag/x', // non-terminator after the name → no match
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

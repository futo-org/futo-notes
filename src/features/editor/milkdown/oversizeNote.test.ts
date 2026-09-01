import { describe, expect, it } from 'vitest';

import { DEFAULT_OVERSIZE_LIMITS, assessOversizeNote, largestInlineRun } from './oversizeNote';

const SENTENCE = (i: number) =>
  `Line ${i + 1} of this note is an ordinary sentence about something.`;
const repeat = (n: number, make: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => make(i));

/* The limits under test, shrunk so a case is a few lines of markdown rather
 * than a megabyte of it. The shipped numbers are asserted separately below. */
const LIMITS = { maxRunLines: 5, maxRunChars: 10_000, previewLines: 3, previewChars: 10_000 };

describe('largestInlineRun', () => {
  it('counts consecutive paragraph lines as one run', () => {
    expect(largestInlineRun('a\nb\nc')).toEqual({ lines: 3, chars: 5 });
  });

  it('ends a run at a blank line', () => {
    expect(largestInlineRun('a\nb\n\nc').lines).toBe(2);
  });

  it('reports the LARGEST run, not the last one', () => {
    expect(largestInlineRun('a\nb\nc\n\nd').lines).toBe(3);
  });

  it('treats a note with no blank line anywhere as one run', () => {
    expect(largestInlineRun(repeat(500, SENTENCE).join('\n')).lines).toBe(500);
  });

  /* The measured split: these shapes cost the same superlinear parse time as a
   * bare paragraph, because each feeds ONE inline content run. */
  it('counts blockquote lines as one run', () => {
    expect(largestInlineRun(repeat(40, (i) => `> ${SENTENCE(i)}`).join('\n')).lines).toBe(40);
  });

  it('counts table rows as one run', () => {
    const table = ['| a | b |', '| --- | --- |', ...repeat(40, (i) => `| ${SENTENCE(i)} | x |`)];
    expect(largestInlineRun(table.join('\n')).lines).toBe(42);
  });

  /* ...and these do not, which is why they must not be capped. */
  it('breaks the run at every list marker', () => {
    expect(largestInlineRun(repeat(40, (i) => `- ${SENTENCE(i)}`).join('\n')).lines).toBe(1);
  });

  it('breaks the run at every heading', () => {
    expect(largestInlineRun(repeat(40, (i) => `# ${SENTENCE(i)}`).join('\n')).lines).toBe(1);
  });

  it("counts a list item's own lazy continuation lines, which are inline content", () => {
    // The marker line starts a run of its own; the two lazy continuations join
    // it, because they are the same paragraph inside the item.
    expect(largestInlineRun('- item\ncontinued\nstill going').lines).toBe(3);
  });

  it('ignores the contents of a fenced code block', () => {
    const note = ['```js', ...repeat(40, SENTENCE), '```'].join('\n');
    expect(largestInlineRun(note).lines).toBe(0);
  });

  it('ignores a tilde fence too', () => {
    expect(largestInlineRun(['~~~', ...repeat(40, SENTENCE), '~~~'].join('\n')).lines).toBe(0);
  });

  /* ```` ```toml` ```` is a PARAGRAPH in CommonMark, not a fence — the same
   * trap markdownChunks.ts's scanner hit. Reading it as one would stop counting
   * a run that is really still open. */
  it('a backtick line whose info string holds a backtick is a paragraph, not a fence', () => {
    const note = ['```toml`', ...repeat(40, SENTENCE)].join('\n');
    expect(largestInlineRun(note).lines).toBe(41);
  });

  it('counts characters including line terminators', () => {
    expect(largestInlineRun('ab\ncd\n')).toEqual({ lines: 2, chars: 6 });
  });

  it('answers zero for an empty document', () => {
    expect(largestInlineRun('')).toEqual({ lines: 0, chars: 0 });
  });
});

describe('assessOversizeNote', () => {
  it('declines to cap anything within the limits', () => {
    expect(assessOversizeNote(repeat(5, SENTENCE).join('\n'), LIMITS)).toBeNull();
  });

  it('caps a note whose run is past the line limit', () => {
    const note = repeat(20, SENTENCE).join('\n');
    const oversize = assessOversizeNote(note, LIMITS);
    expect(oversize?.run.lines).toBe(20);
    expect(oversize?.totalLines).toBe(20);
  });

  it('caps a note whose run is past the character limit alone', () => {
    const note = ['x'.repeat(50), 'y'.repeat(50)].join('\n');
    expect(assessOversizeNote(note, { ...LIMITS, maxRunChars: 60 })?.run.chars).toBe(101);
  });

  it('mounts a bounded prefix of whole lines', () => {
    const note = repeat(20, SENTENCE).join('\n');
    const oversize = assessOversizeNote(note, LIMITS);
    expect(oversize?.previewLines).toBe(3);
    expect(oversize?.preview).toBe(`${SENTENCE(0)}\n${SENTENCE(1)}\n${SENTENCE(2)}\n`);
    expect(note.startsWith(oversize!.preview)).toBe(true);
  });

  it('bounds the preview by characters when the lines are long', () => {
    const note = repeat(20, () => 'x'.repeat(100)).join('\n');
    const oversize = assessOversizeNote(note, { ...LIMITS, previewChars: 150 });
    expect(oversize?.previewLines).toBe(2);
  });

  it('never caps a 10,000-item list or a 10,000-line fence at the shipped limits', () => {
    const list = repeat(10_000, (i) => `- ${SENTENCE(i)}`).join('\n');
    const fence = ['```js', ...repeat(10_000, SENTENCE), '```'].join('\n');
    expect(assessOversizeNote(list)).toBeNull();
    expect(assessOversizeNote(fence)).toBeNull();
  });

  it('caps the reported note: 50,000 lines with no blank line anywhere', () => {
    const note = repeat(50_000, SENTENCE).join('\n');
    const oversize = assessOversizeNote(note);
    expect(oversize?.totalLines).toBe(50_000);
    expect(oversize?.previewLines).toBe(DEFAULT_OVERSIZE_LIMITS.previewLines);
  });

  it('leaves the largest ordinary note in the population study alone', () => {
    // §2's population study: every note in the maintainer's vault except one is
    // ≤978 lines, and the exception is 13,877 lines of ordinary prose — blocks
    // separated by blank lines. Neither may be capped.
    const ordinary = repeat(13_877, (i) => (i % 4 === 3 ? '' : SENTENCE(i))).join('\n');
    expect(assessOversizeNote(ordinary)).toBeNull();
  });
});

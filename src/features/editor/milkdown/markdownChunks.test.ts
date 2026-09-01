import { describe, expect, it } from 'vitest';

import { planMarkdownChunks } from './markdownChunks';

/** The one invariant every plan must satisfy, whatever it decided. */
function expectLossless(markdown: string): string[] {
  const plan = planMarkdownChunks(markdown, { minLines: 0, firstChunkLines: 2, chunkLines: 2 });
  expect(plan.chunks.join('')).toBe(markdown);
  return plan.chunks;
}

describe('planMarkdownChunks — losslessness', () => {
  it('concatenates back to the exact input, including the trailing newline', () => {
    expect(expectLossless('# a\n\nb\n\nc\n').join('')).toBe('# a\n\nb\n\nc\n');
  });

  it('handles an empty document', () => {
    const plan = planMarkdownChunks('');
    expect(plan.chunks).toEqual(['']);
    expect(plan.chunked).toBe(false);
  });

  it('handles a document with no trailing newline', () => {
    expect(expectLossless('a\n\nb').join('')).toBe('a\n\nb');
  });

  it('preserves CRLF bytes verbatim', () => {
    expect(expectLossless('a\r\n\r\nb\r\n').join('')).toBe('a\r\n\r\nb\r\n');
  });
});

describe('planMarkdownChunks — when it declines to chunk', () => {
  it('leaves a short document whole', () => {
    const plan = planMarkdownChunks('a\n\nb\n');
    expect(plan.chunked).toBe(false);
    expect(plan.chunks).toEqual(['a\n\nb\n']);
    expect(plan.declined).toBe('too-short');
  });

  it('declines a document carrying a link reference definition', () => {
    const md = `see [foo]\n\n${'para\n\n'.repeat(200)}[foo]: https://example.com\n`;
    const plan = planMarkdownChunks(md, { minLines: 0 });
    expect(plan.chunked).toBe(false);
    expect(plan.declined).toBe('reference-definition');
  });

  it('declines a document carrying a GFM footnote definition', () => {
    const md = `text[^1]\n\n${'para\n\n'.repeat(200)}[^1]: the note\n`;
    const plan = planMarkdownChunks(md, { minLines: 0 });
    expect(plan.chunked).toBe(false);
    expect(plan.declined).toBe('reference-definition');
  });

  it('does not mistake a fenced code line for a reference definition', () => {
    const md = `\`\`\`\n[foo]: not-a-definition\n\`\`\`\n\n${'para\n\n'.repeat(20)}`;
    const plan = planMarkdownChunks(md, { minLines: 0, firstChunkLines: 2, chunkLines: 2 });
    expect(plan.declined).toBeUndefined();
    expect(plan.chunked).toBe(true);
  });

  it('declines when no safe boundary exists', () => {
    const plan = planMarkdownChunks('a\nb\nc\nd\n', { minLines: 0, firstChunkLines: 1 });
    expect(plan.chunked).toBe(false);
    expect(plan.declined).toBe('no-boundary');
  });
});

describe('planMarkdownChunks — boundary safety', () => {
  const opts = { minLines: 0, firstChunkLines: 1, chunkLines: 1 };

  it('splits at a blank line between top-level blocks', () => {
    expect(planMarkdownChunks('# a\n\nb\n', opts).chunks).toEqual(['# a\n\n', 'b\n']);
  });

  it('keeps a whole blank run with the chunk that precedes it', () => {
    expect(planMarkdownChunks('a\n\n\n\nb\n', opts).chunks).toEqual(['a\n\n\n\n', 'b\n']);
  });

  it('never splits inside a fenced code block', () => {
    const md = '```\nx\n\ny\n```\n\nafter\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['```\nx\n\ny\n```\n\n', 'after\n']);
  });

  it('never splits inside a tilde fence', () => {
    const md = '~~~\nx\n\ny\n~~~\n\nafter\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['~~~\nx\n\ny\n~~~\n\n', 'after\n']);
  });

  it('does not treat a shorter run of backticks as a closing fence', () => {
    const md = '````\n```\n\nstill code\n````\n\nafter\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual([
      '````\n```\n\nstill code\n````\n\n',
      'after\n',
    ]);
  });

  it('never splits a loose list into two lists', () => {
    const md = '- a\n\n- b\n\nafter\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['- a\n\n- b\n\n', 'after\n']);
  });

  it('never splits an ordered loose list', () => {
    const md = '1. a\n\n2. b\n\nafter\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['1. a\n\n2. b\n\n', 'after\n']);
  });

  it('never splits before an indented list continuation', () => {
    const md = '- a\n\n  still the item\n\nafter\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['- a\n\n  still the item\n\n', 'after\n']);
  });

  it('never splits out of an indented code block, even at its end', () => {
    // Which trailing blank lines belong to an indented code block is decided
    // by what follows it — context a chunk boundary would remove.
    const md = '    code\n\n    more code\n\nafter\n';
    expect(planMarkdownChunks(md, opts).chunked).toBe(false);
  });

  it('never splits at a whitespace-only line', () => {
    // Blank at the top level, but content inside an indented code block.
    const md = 'para\n \nafter\n\ntail\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['para\n \nafter\n\n', 'tail\n']);
  });

  it('never splits inside an HTML comment that spans a blank line', () => {
    const md = '<!-- a\n\nb -->\n\nafter\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['<!-- a\n\nb -->\n\n', 'after\n']);
  });

  it('never splits inside a <pre> block that spans a blank line', () => {
    const md = '<pre>\na\n\nb\n</pre>\n\nafter\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['<pre>\na\n\nb\n</pre>\n\n', 'after\n']);
  });

  it('splits a paragraph away from a following list', () => {
    const md = 'para\n\n- a\n- b\n\nafter\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['para\n\n', '- a\n- b\n\n', 'after\n']);
  });

  it('ends a list at an indent-0 paragraph', () => {
    const md = '- a\n\npara\n\nafter\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['- a\n\n', 'para\n\n', 'after\n']);
  });
});

describe('planMarkdownChunks — chunk sizing', () => {
  it('gives the first chunk its own smaller budget', () => {
    const md = Array.from({ length: 40 }, (_, i) => `para ${i}`).join('\n\n') + '\n';
    const plan = planMarkdownChunks(md, { minLines: 0, firstChunkLines: 3, chunkLines: 20 });
    expect(plan.chunked).toBe(true);
    expect(plan.chunks.join('')).toBe(md);
    // 3-line budget: 'para 0\n\n' is 2 lines, 'para 1\n\n' takes it to 4 >= 3.
    expect(plan.chunks[0]).toBe('para 0\n\npara 1\n\n');
    expect(plan.chunks.length).toBeGreaterThan(2);
  });

  it('keeps every chunk after the first at or above the chunk budget', () => {
    const md = Array.from({ length: 200 }, (_, i) => `para ${i}`).join('\n\n') + '\n';
    const plan = planMarkdownChunks(md, { minLines: 0, firstChunkLines: 10, chunkLines: 50 });
    for (const chunk of plan.chunks.slice(1, -1)) {
      expect(chunk.split('\n').length).toBeGreaterThanOrEqual(50);
    }
  });
});

describe('planMarkdownChunks — context-dependent block starts', () => {
  const opts = { minLines: 0, firstChunkLines: 1, chunkLines: 1 };

  it('never cuts in front of an empty list item', () => {
    // `- ` alone means "empty list item" or "a paragraph" depending on the
    // block above it; a chunk of its own strips that context.
    const md = '## A\n\n- \n\n## B\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['## A\n\n- \n\n', '## B\n']);
  });

  it('still cuts in front of a list item that has content', () => {
    const md = '## A\n\n- x\n\n## B\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['## A\n\n', '- x\n\n', '## B\n']);
  });

  it('treats an empty ordered item the same way', () => {
    const md = '## A\n\n1.\n\n## B\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['## A\n\n1.\n\n', '## B\n']);
  });
});

describe('planMarkdownChunks — front matter fences', () => {
  const opts = { minLines: 0, firstChunkLines: 1, chunkLines: 1 };

  it('never cuts in front of a `---` fence', () => {
    // Each chunk is parsed as its own document, and front matter is a
    // document-START construct: a chunk that began with `---` would parse this
    // thematic break plus setext heading as a front matter node, which cannot
    // be appended past the document's first position and would be dropped
    // (packages/editor/src/milkdown-compat/frontmatter.ts).
    const md = '## A\n\n---\n\ntail\n';
    const plan = planMarkdownChunks(md, opts);
    expect(plan.chunks.join('')).toBe(md);
    expect(plan.chunks.some((c) => c.startsWith('---'))).toBe(false);
  });

  it('still cuts in front of a longer dash rule, which cannot open front matter', () => {
    // `----` is a thematic break in every position; the fence must be exactly
    // three dashes, so nothing is at risk here.
    const md = '## A\n\n----\n\ntail\n';
    const plan = planMarkdownChunks(md, opts);
    expect(plan.chunks.join('')).toBe(md);
    expect(plan.chunks.some((c) => c.startsWith('----'))).toBe(true);
  });

  it("never cuts inside the note's own front matter, blank line and all", () => {
    // A blank line inside front matter followed by a column-0 key looks exactly
    // like a top-level block start to the scanner. Cutting there would split
    // the block, and neither half parses as what it was.
    const md = '---\na: 1\n\nb: 2\n---\n\n## A\n\ntail\n';
    const plan = planMarkdownChunks(md, opts);
    expect(plan.chunks.join('')).toBe(md);
    expect(plan.chunks[0].startsWith('---\na: 1\n\nb: 2\n---\n')).toBe(true);
  });

  it("leaves the note's OWN front matter in the first chunk", () => {
    const md = '---\ntitle: T\n---\n\n## A\n\ntail\n';
    const plan = planMarkdownChunks(md, opts);
    expect(plan.chunks.join('')).toBe(md);
    expect(plan.chunks[0]).toBe('---\ntitle: T\n---\n\n');
  });
});

describe('planMarkdownChunks — fence edge cases remark disagrees about', () => {
  const opts = { minLines: 0, firstChunkLines: 1, chunkLines: 1 };

  it('does not let a column-0 fence close one opened inside a list item', () => {
    // The indented fence belongs to the list item; the column-0 run is outside
    // it and opens a NEW code block, which then runs to the end.
    const md = '-  see:\n   ```bash\n   x\n   ```\n\n```\n\nnot a heading\n\n```\n\ntail\n';
    const plan = planMarkdownChunks(md, opts);
    expect(plan.chunks.join('')).toBe(md);
    // Nothing between the two column-0 fences may become a boundary.
    expect(plan.chunks.some((c) => c.startsWith('not a heading'))).toBe(false);
  });

  it('treats a backtick fence with a backtick in its info string as a paragraph', () => {
    const md = 'a\n\n```toml`\nb = 1\n\nstill a paragraph\n\ntail\n';
    const plan = planMarkdownChunks(md, opts);
    expect(plan.chunks.join('')).toBe(md);
    // Not a code block, so the blank lines after it are ordinary boundaries.
    expect(plan.chunks.some((c) => c.startsWith('still a paragraph'))).toBe(true);
  });

  it('still lets a tilde fence carry backticks in its info string', () => {
    const md = 'a\n\n~~~`weird`\ncode\n\nmore code\n~~~\n\ntail\n';
    const plan = planMarkdownChunks(md, opts);
    expect(plan.chunks.some((c) => c.startsWith('more code'))).toBe(false);
  });
});

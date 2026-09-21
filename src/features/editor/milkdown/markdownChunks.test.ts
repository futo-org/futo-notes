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

describe('planMarkdownChunks — non-blank boundaries (hard starters)', () => {
  const opts = { minLines: 0, firstChunkLines: 1, chunkLines: 1 };

  it('cuts a paragraph away from a following heading, with no blank line', () => {
    const md = 'para\n# heading\ntail\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['para\n', '# heading\ntail\n']);
  });

  it('cuts a paragraph away from a following fence, with no blank line', () => {
    const md = 'para\n```\ncode\n```\ntail\n';
    const plan = planMarkdownChunks(md, opts);
    expect(plan.chunks.join('')).toBe(md);
    expect(plan.chunks[0]).toBe('para\n');
  });

  it('cuts a paragraph away from a following blockquote, with no blank line', () => {
    const md = 'para\n> quote\ntail\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['para\n', '> quote\ntail\n']);
  });

  it('cuts a paragraph away from a following list item, with no blank line', () => {
    const md = 'para\n- item\ntail\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['para\n', '- item\ntail\n']);
  });

  it('cuts a paragraph away from a following ordered item starting at 1, with no blank line', () => {
    const md = 'para\n1. item\ntail\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['para\n', '1. item\ntail\n']);
  });

  it('closes a list at a following blockquote, with no blank line', () => {
    const md = '- item\n> quote\ntail\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['- item\n', '> quote\ntail\n']);
  });

  it('closes a blockquote at a following list item, with no blank line', () => {
    const md = '> quote\n- item\ntail\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['> quote\n', '- item\ntail\n']);
  });

  it('closes a blockquote at a following heading, with no blank line', () => {
    const md = '> quote\n# heading\ntail\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['> quote\n', '# heading\ntail\n']);
  });

  it('cuts before both the heading and the reopened list it closed', () => {
    // The heading closes the list `- a` opened; `- b` after it is a NEW list
    // (interrupting a document that has no open list), not a continuation.
    const md = '- a\n# h\n- b\n';
    expect(planMarkdownChunks(md, opts).chunks).toEqual(['- a\n', '# h\n', '- b\n']);
  });

  it('separates the repeating no-blank-line device fixture shape at every transition', () => {
    // paragraph / list item / blockquote / inline code, repeated with no blank
    // line anywhere — the shape tests/lib/editorDevicePerf.mjs's `lineFixture`
    // cycles through. List items and blockquote starts each interrupt, so this
    // now offers plenty of safe boundaries despite having no blank line.
    const md = 'paragraph 0\n- list item 1\n> quoted line 2\n`inline code 3`\n';
    const plan = planMarkdownChunks(md, opts);
    expect(plan.chunks.join('')).toBe(md);
    expect(plan.chunked).toBe(true);
    expect(plan.chunks).toEqual([
      'paragraph 0\n',
      '- list item 1\n',
      '> quoted line 2\n`inline code 3`\n',
    ]);
  });

  describe('never cuts', () => {
    it('a blockquote continuation line already inside the quote', () => {
      const md = '> a\n> b\ntail\n';
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunked).toBe(false);
    });

    it('a blockquote continuation across a lazy (unmarked) line', () => {
      const md = '> a\nlazy\n> c\ntail\n';
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunked).toBe(false);
    });

    it('adjacent bullet items in the same list', () => {
      const md = '- a\n- b\ntail\n';
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunked).toBe(false);
    });

    it('a bullet list across a lazy continuation line', () => {
      const md = '- a\nlazy\n- b\ntail\n';
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunked).toBe(false);
    });

    it('an ordered item that does not start at 1', () => {
      const md = '1. a\n2. b\ntail\n';
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunked).toBe(false);
    });

    it('a paragraph in front of an ordered item that does not start at 1', () => {
      const md = 'para\n2. b\ntail\n';
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunked).toBe(false);
    });

    it('a paragraph in front of an empty list item', () => {
      const md = 'para\n- \ntail\n';
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunked).toBe(false);
    });

    it('a paragraph in front of a `---` thematic/setext line', () => {
      const md = 'para\n---\ntail\n';
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunked).toBe(false);
    });

    it('a paragraph in front of a `===` setext line', () => {
      const md = 'para\n===\ntail\n';
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunked).toBe(false);
    });

    it('inside an over-approximated HTML block (type 6/7), even a line that looks like a heading', () => {
      const md = '<div>\n# not a heading\n</div>\ntail\n';
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunked).toBe(false);
    });

    it('a heading directly after a table, with no blank line', () => {
      const md = '| a | b |\n| - | - |\n| 1 | 2 |\n# h\ntail\n';
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunked).toBe(false);
    });

    it('a table delimiter row that also looks like an interrupting list item', () => {
      // `- | -` matches INTERRUPTING_LIST_ITEM AND is a valid GFM table
      // delimiter row; remark-gfm reads the whole thing as ONE table, so
      // cutting in front of the delimiter row would turn it into a paragraph
      // plus a list.
      const md = 'a | b\n- | -\nc | d\n';
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunked).toBe(false);
    });

    it('anything after a fence opened inside a list item that never closes', () => {
      const md = '- foo\n  ```\n  code\n# x\ntail\n';
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunks.join('')).toBe(md);
      expect(plan.chunked).toBe(false);
    });

    it('adjacent indented code-block lines', () => {
      const md = '    code\n    more code\ntail\n';
      const plan = planMarkdownChunks(md, { minLines: 0, firstChunkLines: 1, chunkLines: 1 });
      // Neither line starts at column 0, so neither can be a hard starter.
      expect(plan.chunked).toBe(false);
    });

    it('a heading indented 1-3 columns — only column 0 counts', () => {
      const md = 'para\n  # h\ntail\n';
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunked).toBe(false);
    });

    it('a paragraph of plain sentences has no boundary', () => {
      // tests/editor-embed-milkdown.spec.ts's `oneParagraphNote`: no starters
      // anywhere, so it still declines exactly as before this change.
      const lines = Array.from(
        { length: 20 },
        (_, i) => `Line ${i + 1} of this note is an ordinary sentence about something.`,
      ).join('\n');
      const plan = planMarkdownChunks(lines, opts);
      expect(plan.chunked).toBe(false);
      expect(plan.declined).toBe('no-boundary');
    });
  });
});

describe('planMarkdownChunks — the no-blank-line device fixture, at real size', () => {
  /**
   * Copied from tests/lib/editorDevicePerf.mjs's `contentLine`, because that
   * module is plain node and this is a co-located TS unit test — see its own
   * comment for why the copy exists (AGENTS.md §12 unlocked duplicate).
   */
  function contentLine(index: number): string {
    switch (index % 4) {
      case 0:
        return `paragraph ${index} with **bold** and [a link](https://example.test/${index})`;
      case 1:
        return `- list item ${index}`;
      case 2:
        return `> quoted line ${index}`;
      default:
        return `\`inline code ${index}\``;
    }
  }

  function lineFixture(lines: number): string {
    return Array.from({ length: lines }, (_, index) => contentLine(index)).join('\n');
  }

  it('chunks with DEFAULT options despite having no blank line anywhere', () => {
    const md = lineFixture(1_000) + '\n';
    const plan = planMarkdownChunks(md);
    expect(plan.chunks.join('')).toBe(md);
    expect(plan.chunked).toBe(true);
    // A generous ceiling on the first chunk: list-item and blockquote-start
    // transitions offer a boundary every 2-4 lines in this fixture, well
    // inside the 80-line default budget.
    expect(plan.chunks[0].split('\n').length).toBeLessThanOrEqual(90);
  });
});

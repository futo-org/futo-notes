import { describe, expect, it } from 'vitest';
import { planMarkdownChunks } from './markdownChunks';

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
      // tests/editor-embed-milkdown-parse-cap.spec.ts's `oneParagraphNote`: no starters
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

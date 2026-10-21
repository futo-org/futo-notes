import { describe, expect, it } from 'vitest';
import { planMarkdownChunks } from './markdownChunks';

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

/*
 * The planner stops trusting itself, rather than modeling, whatever it cannot
 * prove is top-level and block-bounded (RC-39, RC-40, RC-38 in the release-
 * hardening campaign). Each shape below is one the l6b fuzz found the scanner
 * cutting inside. The end-to-end proof that the LOADED note is right is in
 * tests/editor-embed-milkdown-progressive-open.spec.ts (progressive section).
 */
describe('planMarkdownChunks — stops at what it cannot prove', () => {
  const opts = { minLines: 0, firstChunkLines: 1, chunkLines: 1 };
  const pad = 'para\n\n'.repeat(5);
  const shapes: Array<[string, string]> = [
    ['an HTML comment that spans a blank line', '<!-- a\n\nb -->\n\nafter\n'],
    ['a <pre> block that spans a blank line', '<pre>\na\n\nb\n</pre>\n\nafter\n'],
    ['a bare inline tag opening a line', '<span>x</span>\n\nafter\n'],
    [
      'a fence line directly under an HTML block',
      '<div>\n```\n\ntext\n\n````\n# c\n\nmore\n````\n\nafter\n',
    ],
    ['a fence indented one space', ' ```\ncode\n```\n\ntext\n ```\n# c\n\nmore\n```\n\nafter\n'],
    ['a fence opened on a list item line', '- ~~~\n  code\n\n\n\nafter\n'],
    ['a fence inside a list item', '1. see:\n   ```bash\n   x\n   ```\n\nafter\n'],
    ['a fence inside a blockquote', '> ```\n> x\n\n\nafter\n'],
    ['a lone CR', 'para\r```\n\n# in code\n\n```\n\nafter\n'],
    ['a NBSP-only line', 'para\n\n\u00a0\n2. not a list\n\nafter\n'],
    ['an ideographic-space-only line', 'para\n\n\u3000\n2. not a list\n\nafter\n'],
    ['a form-feed-only line', 'para\n\n\f\n2. not a list\n\nafter\n'],
    ['U+2028 in a line', 'para\u2028```\n\nafter\n'],
    ['an HTML comment opened in a list item', '- <!--\n\ntext\n\n- b\n'],
    ['a <pre> opened in a list item', '- <pre>\n\n  foo\n\n# h\n</pre>\n\nafter\n'],
    ['a <pre> opened in a blockquote', '> <pre>\n\nfoo\n\n# h\n</pre>\n\nafter\n'],
    ['a <pre> opened in an ordered item', '1. <pre>\n\n# h\n\nafter\n'],
    ['a <script> opened in a nested item', '  * <script>\n\n# h\n\nafter\n'],
    ['a U+FEFF in the middle of the note', 'para\n\n\ufeff# not a heading\n\nafter\n'],
  ];

  for (const [name, tail] of shapes) {
    it(`never cuts at or after ${name}`, () => {
      const md = `${pad}${tail}${pad}`;
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunks.join('')).toBe(md);
      // The head is still cut up; from the offending line on, one chunk.
      expect(plan.chunked).toBe(true);
      expect(plan.stoppedBy).toBeDefined();
      expect(plan.chunks.at(-1)?.endsWith(`${tail}${pad}`)).toBe(true);
    });

    it(`leaves a note that opens with ${name} whole`, () => {
      const md = `${tail}${pad}`;
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunks).toEqual([md]);
      expect(plan.chunked).toBe(false);
    });
  }

  const definitions: Array<[string, string]> = [
    ['a definition in a list item', '- [a]: https://e.com/x\n\nafter\n'],
    ['a definition in a blockquote', '> [a]: https://e.com/x\n\nafter\n'],
    ['a definition with an escaped bracket', '[si\\]te]: https://e.com/x\nmore\n\nafter\n'],
    ['a definition whose label spans two lines', '[my\nsite]: https://e.com/x\nmore\n\nafter\n'],
    ['a footnote definition in a list item', '- [^n]: note body\n\nafter\n'],
  ];

  for (const [name, tail] of definitions) {
    it(`declines the whole note for ${name}`, () => {
      const md = `${pad}${tail}${pad}`;
      const plan = planMarkdownChunks(md, opts);
      expect(plan.chunked).toBe(false);
      expect(plan.declined).toBe('reference-definition');
      expect(plan.chunks).toEqual([md]);
    });
  }

  it('sees a two-line label whose second line is the line it stopped at', () => {
    const md = '[a <span>]\n\n# h\n\n[a\n<span>]: /u\n\ntext\n';
    expect(planMarkdownChunks(md, opts).declined).toBe('reference-definition');
  });

  it('does not stop at a URL autolink in a list item', () => {
    const md = `${pad}- <https://example.com/x>\n\nafter\n${pad}`;
    expect(planMarkdownChunks(md, opts).stoppedBy).toBeUndefined();
  });

  it('does not let a fence-looking line in the front matter open a fence', () => {
    const md = `---\n\`\`\`\ntitle: x\n---\n\nintro\n\n# one\n\n# two\n\ntext\n`;
    const plan = planMarkdownChunks(md, opts);
    expect(plan.chunks.join('')).toBe(md);
    expect(plan.chunked).toBe(true);
    expect(plan.chunks.some((c) => c.startsWith('# two'))).toBe(true);
  });

  it('declines for a definition that comes AFTER the point it stopped trusting the scan', () => {
    const md = `${pad}<div>\n\n${pad}- [a]: https://e.com/x\n`;
    expect(planMarkdownChunks(md, opts).declined).toBe('reference-definition');
  });

  it('still chunks a note whose tags and definition-looking lines sit inside a column-0 fence', () => {
    const md = `\`\`\`\n<div>\n[a]: not a definition\n\`\`\`\n\n${pad}`;
    const plan = planMarkdownChunks(md, opts);
    expect(plan.chunked).toBe(true);
    expect(plan.stoppedBy).toBeUndefined();
  });

  it('keeps a column-0 fence that is never closed as one chunk to the end', () => {
    const md = `${pad}\`\`\`\ncode\n\nmore\n`;
    const plan = planMarkdownChunks(md, opts);
    expect(plan.chunks.join('')).toBe(md);
    expect(plan.chunks.at(-1)).toBe('```\ncode\n\nmore\n');
  });
});

describe('planMarkdownChunks — a leading U+FEFF', () => {
  const opts = { minLines: 0, firstChunkLines: 1, chunkLines: 1 };

  it('is scanned as absent but stays in the first chunk', () => {
    const md = '\ufeffFirst para\n\nsecond para\n\nthird\n';
    const plan = planMarkdownChunks(md, opts);
    expect(plan.chunked).toBe(true);
    expect(plan.chunks.join('')).toBe(md);
    expect(plan.chunks[0].startsWith('\ufeff')).toBe(true);
    // No later chunk starts at a U+FEFF, which micromark would strip.
    expect(plan.chunks.slice(1).some((c) => c.startsWith('\ufeff'))).toBe(false);
  });

  it("still sees the note's own front matter behind it", () => {
    const md = '\ufeff---\na: 1\n\nb: 2\n---\n\nbody\n\nmore\n';
    const plan = planMarkdownChunks(md, opts);
    expect(plan.chunks.join('')).toBe(md);
    // The blank line inside the front matter is not a boundary.
    expect(plan.chunks.some((c) => c.startsWith('b: 2'))).toBe(false);
  });
});

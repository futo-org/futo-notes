import { fromMarkdown } from 'mdast-util-from-markdown';
import remarkFrontmatter from 'remark-frontmatter';
import { describe, expect, it } from 'vitest';

import { hasClosingFrontmatterFence } from './frontmatter';

/**
 * `editor-embed-milkdown-compat.spec.ts` proves the guard end to end through
 * the real Milkdown bundle. This file holds its canary, which cannot live there:
 * the unpatched preset has no front matter at all, so the upstream bug is only
 * reachable through `remark-frontmatter` itself.
 */

/** The top-level node types plain `remark-frontmatter` parses `markdown` into. */
function upstreamKinds(markdown: string): string[] {
  const data: Record<string, unknown[]> = {};
  (remarkFrontmatter as (this: unknown, settings: unknown) => void).call({ data: () => data }, [
    'yaml',
  ]);
  const tree = fromMarkdown(markdown, {
    extensions: data.micromarkExtensions,
    mdastExtensions: data.fromMarkdownExtensions,
  } as Parameters<typeof fromMarkdown>[1]);
  return tree.children.map((child) => child.type);
}

describe('an opening `---` with no closing fence', () => {
  it('canary: upstream still flattens every later list and quote into paragraphs', () => {
    // When this goes red, micromark-extension-frontmatter stopped taking the
    // containers with it: delete remarkClosedFrontmatter's guard.
    expect(upstreamKinds('---\n\n- a\n- b\n\n> quote\n')).toEqual([
      'thematicBreak',
      'paragraph',
      'paragraph',
    ]);
    expect(upstreamKinds('---\ntitle: x\n---\n\n- a\n')).toEqual(['yaml', 'list']);
  });
});

describe('hasClosingFrontmatterFence', () => {
  const CASES: [string, string, boolean][] = [
    ['a closed block', '---\na: 1\n---\n\nbody\n', true],
    ['an empty block', '---\n---\n', true],
    ['a closing fence at the end of the file', '---\na: 1\n---', true],
    ['a closing fence with trailing spaces and a tab', '---\na: 1\n---  \t\nbody\n', true],
    ['CRLF line endings', '---\r\na: 1\r\n---\r\n', true],
    ['CR line endings', '---\ra: 1\r---\r', true],
    ['a byte-order mark', '\uFEFF---\na: 1\n---\n', true],
    ['a closing fence after a blank line', '---\na: 1\n\n- b\n---\n', true],
    ['no closing fence', '---\n\n- a\n\n> q\n', false],
    ['only a longer rule later', '---\na: 1\n----\n', false],
    ['only an indented fence later', '---\na: 1\n ---\n', false],
    ['only a fence with text after it', '---\na: 1\n--- x\n', false],
    ['a CRLF note with no closing fence', '---\r\n\r\n- a\r\n', false],
    // The construct itself refuses these, so the guard has nothing to say.
    ['a first line that is not a fence', 'body\n---\n', true],
    ['a lone fence at the end of the file', '---', true],
  ];
  for (const [name, markdown, expected] of CASES) {
    it(`${expected ? 'accepts' : 'rejects'} ${name}`, () => {
      expect(hasClosingFrontmatterFence(markdown)).toBe(expected);
    });
  }
});

import { describe, expect, it } from 'vitest';

import { resolveSourceOffset } from './sourcePositions';

const DOC = ['# Heading one', '', '- alpha item', '- beta item', '', 'A **bold** word.'].join('\n');

describe('resolveSourceOffset', () => {
  it('maps the start of each top-level block to that block at text offset 0', () => {
    expect(resolveSourceOffset(DOC, 0)).toEqual({ blockIndex: 0, textOffset: 0 });
    expect(resolveSourceOffset(DOC, DOC.indexOf('- alpha'))).toEqual({
      blockIndex: 1,
      textOffset: 0,
    });
    expect(resolveSourceOffset(DOC, DOC.indexOf('A **bold**'))).toEqual({
      blockIndex: 2,
      textOffset: 0,
    });
  });

  it('counts only reader-visible characters, never syntax markers', () => {
    // End of the heading block: '# ' is a marker, so 'Heading one' is 11 chars.
    expect(resolveSourceOffset(DOC, DOC.indexOf('\n\n- alpha'))).toEqual({
      blockIndex: 0,
      textOffset: 'Heading one'.length,
    });
    // End of the final paragraph: the '**' pairs are markers.
    expect(resolveSourceOffset(DOC, DOC.length)).toEqual({
      blockIndex: 2,
      textOffset: 'A bold word.'.length,
    });
  });

  it('places an offset inside a block at its visible prefix', () => {
    expect(resolveSourceOffset(DOC, DOC.indexOf('bold'))).toEqual({
      blockIndex: 2,
      textOffset: 'A '.length,
    });
  });

  it('attributes an offset in the blank space between blocks to the block before it', () => {
    const between = DOC.indexOf('- alpha') - 1;
    expect(resolveSourceOffset(DOC, between).blockIndex).toBe(0);
  });

  it('clamps an offset past the end of the document to the last block', () => {
    expect(resolveSourceOffset(DOC, DOC.length + 50).blockIndex).toBe(2);
  });

  it('resolves an empty document to the first block at offset 0', () => {
    expect(resolveSourceOffset('', 0)).toEqual({ blockIndex: 0, textOffset: 0 });
  });

  it('treats list markers and blockquote markers as invisible', () => {
    const quoted = '> quoted text';
    expect(resolveSourceOffset(quoted, quoted.length)).toEqual({
      blockIndex: 0,
      textOffset: 'quoted text'.length,
    });
  });

  it('keeps fence content visible but not the fence markers', () => {
    const fenced = '```js\nconst a = 1;\n```';
    expect(resolveSourceOffset(fenced, fenced.length)).toEqual({
      blockIndex: 0,
      textOffset: 'const a = 1;\n'.length,
    });
  });
});

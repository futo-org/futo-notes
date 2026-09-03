import { describe, expect, it } from 'vitest';

import { blankLineJoin, fixEmptyLinePlaceholders, restoreBlankLineParagraphs } from './emptyLine';
import type { MdastNode } from './mdast';

/**
 * The trees below are the shapes remark actually produces — each case names the
 * markdown it came from. `editor-embed-milkdown-compat.spec.ts` proves the same
 * cases end to end through the real Milkdown bundle; these pin the rule itself.
 */
const br = (value = '<br />'): MdastNode => ({ type: 'html', value });
const text = (value: string): MdastNode => ({ type: 'text', value });
/** A one-line block on source line `line` (positions are what the gap rule reads). */
const at = (line: number, node: MdastNode, endLine = line): MdastNode => ({
  ...node,
  position: { start: { line }, end: { line: endLine } },
});
const para = (value: string): MdastNode => ({ type: 'paragraph', children: [text(value)] });
const empty = (): MdastNode => ({ type: 'paragraph', children: [] });

function types(node: MdastNode): string[] {
  return (node.children ?? []).map((child) => child.type);
}

/** `p` for a paragraph with text, `_` for an empty one, the type otherwise. */
function shape(node: MdastNode): string {
  return (node.children ?? [])
    .map((child) =>
      child.type === 'paragraph' ? (child.children?.length ? 'p' : '_') : child.type,
    )
    .join(' ');
}

describe('restoreBlankLineParagraphs', () => {
  it('leaves a single blank line alone — that is the block boundary', () => {
    // "a\n\nb"
    const root: MdastNode = { type: 'root', children: [at(1, para('a')), at(3, para('b'))] };
    restoreBlankLineParagraphs(root);
    expect(shape(root)).toBe('p p');
  });

  it('turns N blank lines between blocks into N-1 empty paragraphs', () => {
    // "a\n\n\nb" and "a\n\n\n\nb"
    const two: MdastNode = { type: 'root', children: [at(1, para('a')), at(4, para('b'))] };
    restoreBlankLineParagraphs(two);
    expect(shape(two)).toBe('p _ p');

    const three: MdastNode = { type: 'root', children: [at(1, para('a')), at(5, para('b'))] };
    restoreBlankLineParagraphs(three);
    expect(shape(three)).toBe('p _ _ p');
  });

  it('measures from the END of a multi-line block', () => {
    // "- x\n- y\n\n\nb" — the list spans lines 1–2.
    const list: MdastNode = { type: 'list', children: [] };
    const root: MdastNode = { type: 'root', children: [at(1, list, 2), at(5, para('b'))] };
    restoreBlankLineParagraphs(root);
    expect(shape(root)).toBe('list _ p');
  });

  it('restores blank lines before the first block of the document', () => {
    // "\n\nfoo"
    const root: MdastNode = { type: 'root', children: [at(3, para('foo'))] };
    restoreBlankLineParagraphs(root);
    expect(shape(root)).toBe('_ _ p');
  });

  it('does not restore leading blank lines inside a container', () => {
    // ">\n> a" — the bare `>` is the quote's marker line, not a paragraph.
    const quote: MdastNode = at(1, { type: 'blockquote', children: [at(2, para('a'))] }, 2);
    restoreBlankLineParagraphs({ type: 'root', children: [quote] });
    expect(shape(quote)).toBe('p');
  });

  it('restores gaps between siblings inside a container', () => {
    // "> a\n>\n>\n> b" and "- a\n\n\n  b"
    const quote: MdastNode = at(
      1,
      { type: 'blockquote', children: [at(1, para('a')), at(4, para('b'))] },
      4,
    );
    const item: MdastNode = at(
      1,
      { type: 'listItem', children: [at(1, para('a')), at(4, para('b'))] },
      4,
    );
    restoreBlankLineParagraphs({ type: 'root', children: [quote, item] });
    expect(shape(quote)).toBe('p _ p');
    expect(shape(item)).toBe('p _ p');
  });

  it('never restores trailing blank lines — there is no next block to gap to', () => {
    // "a\n\n\n\n" — root positions are not consulted for the tail.
    const root: MdastNode = at(1, { type: 'root', children: [at(1, para('a'))] }, 5);
    restoreBlankLineParagraphs(root);
    expect(shape(root)).toBe('p');
  });

  it('counts a legacy <br /> block as a sibling, so the tag becomes exactly one paragraph', () => {
    // "a\n\n<br />\n\nb" — both gaps are one line; the tag is the paragraph.
    const root: MdastNode = {
      type: 'root',
      children: [at(1, para('a')), at(3, br()), at(5, para('b'))],
    };
    restoreBlankLineParagraphs(root);
    fixEmptyLinePlaceholders(root);
    expect(shape(root)).toBe('p _ p');
  });

  it('leaves a tree without positions alone', () => {
    const root: MdastNode = { type: 'root', children: [para('a'), para('b')] };
    restoreBlankLineParagraphs(root);
    expect(shape(root)).toBe('p p');
  });
});

describe('blankLineJoin', () => {
  it('asks for a single newline after an empty paragraph', () => {
    // `a`, empty, `b` → "a" + "\n\n" + "" + "\n" + "b" = two blank lines.
    expect(blankLineJoin(empty())).toBe(0);
  });

  it('defers to the library for everything else', () => {
    expect(blankLineJoin(para('a'))).toBeUndefined();
    expect(blankLineJoin({ type: 'heading', children: [text('h')] })).toBeUndefined();
    expect(blankLineJoin({ type: 'thematicBreak' })).toBeUndefined();
  });

  it("carries a list's marker across the empty paragraphs to the next list", () => {
    // `containerFlow` calls join(list, empty), then serializes the empty
    // paragraph and clears bulletLastUsed, then calls join(empty, list). The
    // second list must still see `*` so it alternates to `-`.
    const list = { type: 'list', children: [{ type: 'listItem' }] };
    const state = { bulletLastUsed: '*' as string | undefined };
    expect(blankLineJoin(list, empty(), null, state)).toBeUndefined();
    state.bulletLastUsed = undefined; // containerFlow's reset after the empty paragraph
    expect(blankLineJoin(empty(), empty(), null, state)).toBe(0);
    expect(blankLineJoin(empty(), list, null, state)).toBe(0);
    expect(state.bulletLastUsed).toBe('*');
  });

  it('forgets the marker once a real block sits between the lists', () => {
    const list = { type: 'list', children: [{ type: 'listItem' }] };
    const state = { bulletLastUsed: '*' as string | undefined };
    blankLineJoin(list, empty(), null, state);
    state.bulletLastUsed = undefined;
    expect(blankLineJoin(empty(), para('x'), null, state)).toBe(0);
    expect(blankLineJoin(para('x'), list, null, state)).toBeUndefined();
    expect(state.bulletLastUsed).toBeUndefined();
  });
});

describe('fixEmptyLinePlaceholders', () => {
  describe('reads the placeholder an older build wrote as the empty paragraph it stood for', () => {
    it('replaces a block-level <br /> in the document body', () => {
      // "para\n\n<br />\n\npara" — a lone <br /> is an HTML block, not a paragraph.
      const tree: MdastNode = {
        type: 'root',
        children: [{ type: 'paragraph', children: [text('para')] }, br()],
      };
      fixEmptyLinePlaceholders(tree);
      expect(shape(tree)).toBe('p _');
    });

    it('drops the sole content of an empty table cell', () => {
      // "| <br /> | x |" — how Milkdown writes a cell with no content.
      const cell: MdastNode = { type: 'tableCell', children: [br()] };
      fixEmptyLinePlaceholders({ type: 'root', children: [cell] });
      expect(cell.children).toEqual([]);
    });

    it('replaces the sole content of an empty list item', () => {
      // "- <br />"
      const item: MdastNode = { type: 'listItem', children: [br()] };
      fixEmptyLinePlaceholders({ type: 'root', children: [item] });
      expect(shape(item)).toBe('_');
    });

    it('replaces it in a blockquote and a footnote definition', () => {
      // "> <br />" and "[^4]: <br />"
      for (const type of ['blockquote', 'footnoteDefinition']) {
        const parent: MdastNode = { type, children: [br()] };
        fixEmptyLinePlaceholders({ type: 'root', children: [parent] });
        expect(shape(parent), type).toBe('_');
      }
    });

    it('accepts every spelling the serializer could emit', () => {
      for (const value of ['<br />', '<br>', '<br >', '<br/>', '  <br />  ']) {
        const root: MdastNode = { type: 'root', children: [br(value)] };
        fixEmptyLinePlaceholders(root);
        expect(shape(root), value).toBe('_');
      }
    });
  });

  describe('keeps the line break the author wrote', () => {
    it('keeps an inline <br> between two sentences', () => {
      // "sentence one.<br>sentence two." — upstream deletes this, fusing the two.
      const paragraph: MdastNode = {
        type: 'paragraph',
        children: [text('sentence one.'), br('<br>'), text('sentence two.')],
      };
      fixEmptyLinePlaceholders({ type: 'root', children: [paragraph] });
      expect(types(paragraph)).toEqual(['text', 'html', 'text']);
    });

    it('keeps a <br> inside a table cell that has text', () => {
      // "| one.<br>two. | x |" — the only legal multi-line GFM cell.
      const cell: MdastNode = {
        type: 'tableCell',
        children: [text('one.'), br('<br>'), text('two.')],
      };
      fixEmptyLinePlaceholders({ type: 'root', children: [cell] });
      expect(types(cell)).toEqual(['text', 'html', 'text']);
    });

    it('keeps a <br> on its own line inside a soft-wrapped paragraph', () => {
      // "line a\n<br />\nline b" — one paragraph, not a blank line.
      const paragraph: MdastNode = {
        type: 'paragraph',
        children: [text('line a\n'), br(), text('\nline b')],
      };
      fixEmptyLinePlaceholders({ type: 'root', children: [paragraph] });
      expect(types(paragraph)).toEqual(['text', 'html', 'text']);
    });

    it('moves a kept <br> in front of the hard breaks before it', () => {
      // "a  \n<br/>b" — remark cannot write an eol directly before inline HTML,
      // so leaving the tag second strands the hard break's backslash mid-line.
      const paragraph: MdastNode = {
        type: 'paragraph',
        children: [text('a'), { type: 'break' }, br('<br/>'), text('b')],
      };
      fixEmptyLinePlaceholders({ type: 'root', children: [paragraph] });
      expect(types(paragraph)).toEqual(['text', 'html', 'break', 'text']);
    });

    it('moves it in front of a whole run of hard breaks', () => {
      const paragraph: MdastNode = {
        type: 'paragraph',
        children: [text('a'), { type: 'break' }, { type: 'break' }, br('<br/>'), text('b')],
      };
      fixEmptyLinePlaceholders({ type: 'root', children: [paragraph] });
      expect(types(paragraph)).toEqual(['text', 'html', 'break', 'break', 'text']);
    });

    it('moves it in front of a soft line break too', () => {
      // The soft break is lost the same way — it just leaves no backslash
      // behind to make it obvious.
      const paragraph: MdastNode = {
        type: 'paragraph',
        children: [text('a'), { type: 'break', data: { isInline: true } }, br('<br/>'), text('b')],
      };
      fixEmptyLinePlaceholders({ type: 'root', children: [paragraph] });
      expect(types(paragraph)).toEqual(['text', 'html', 'break', 'text']);
    });

    it('leaves other HTML alone', () => {
      const paragraph: MdastNode = {
        type: 'paragraph',
        children: [{ type: 'html', value: '<kbd>' }, text('K'), { type: 'html', value: '</kbd>' }],
      };
      fixEmptyLinePlaceholders({ type: 'root', children: [paragraph] });
      expect(types(paragraph)).toEqual(['html', 'text', 'html']);
    });

    it('keeps a lone <br> under a parent it does not recognise', () => {
      // Unknown parents default to keeping: a stray literal `<br />` is
      // cosmetic, a deleted line break is data loss.
      const parent: MdastNode = { type: 'someFutureExtension', children: [br(), text('x')] };
      fixEmptyLinePlaceholders({ type: 'root', children: [parent] });
      expect(types(parent)).toEqual(['html', 'text']);
    });
  });
});

import { describe, expect, it } from 'vitest';

import { fixEmptyLinePlaceholders, htmlWithoutEmptyCellPlaceholder } from './emptyLine';
import type { MdastNode } from './mdast';

/**
 * The trees below are the shapes remark actually produces — each case names the
 * markdown it came from. `editor-embed-milkdown-compat.spec.ts` proves the same
 * cases end to end through the real Milkdown bundle; these pin the rule itself.
 */
const br = (value = '<br />'): MdastNode => ({ type: 'html', value });
const text = (value: string): MdastNode => ({ type: 'text', value });

function types(node: MdastNode): string[] {
  return (node.children ?? []).map((child) => child.type);
}

describe('fixEmptyLinePlaceholders', () => {
  describe('deletes the placeholder Milkdown emitted', () => {
    it('drops a block-level <br /> in the document body', () => {
      // "para\n\n<br />\n\npara" — a lone <br /> is an HTML block, not a paragraph.
      const tree: MdastNode = {
        type: 'root',
        children: [{ type: 'paragraph', children: [text('para')] }, br()],
      };
      fixEmptyLinePlaceholders(tree);
      expect(types(tree)).toEqual(['paragraph']);
    });

    it('drops the sole content of an empty table cell', () => {
      // "| <br /> | x |" — how Milkdown writes a cell with no content.
      const cell: MdastNode = { type: 'tableCell', children: [br()] };
      fixEmptyLinePlaceholders({ type: 'root', children: [cell] });
      expect(cell.children).toEqual([]);
    });

    it('drops the sole content of an empty list item', () => {
      // "- <br />"
      const item: MdastNode = { type: 'listItem', children: [br()] };
      fixEmptyLinePlaceholders({ type: 'root', children: [item] });
      expect(item.children).toEqual([]);
    });

    it('drops it in a blockquote and a footnote definition', () => {
      // "> <br />" and "[^4]: <br />"
      for (const type of ['blockquote', 'footnoteDefinition']) {
        const parent: MdastNode = { type, children: [br()] };
        fixEmptyLinePlaceholders({ type: 'root', children: [parent] });
        expect(parent.children, type).toEqual([]);
      }
    });

    it('accepts every spelling the serializer can emit', () => {
      for (const value of ['<br />', '<br>', '<br >', '<br/>', '  <br />  ']) {
        const root: MdastNode = { type: 'root', children: [br(value)] };
        fixEmptyLinePlaceholders(root);
        expect(root.children, value).toEqual([]);
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

describe('htmlWithoutEmptyCellPlaceholder', () => {
  const handler = htmlWithoutEmptyCellPlaceholder();
  // On the serialize side the placeholder sits inside the paragraph the
  // ProseMirror table_cell wraps its content in; state.stack carries the
  // mdast-util-gfm-table 'tableCell' construct while a cell serializes.
  const soleChildParagraph = (child: MdastNode): MdastNode => ({
    type: 'paragraph',
    children: [child],
  });
  const inCell = { stack: ['table', 'tableRow', 'tableCell', 'phrasing'] };
  const inBody = { stack: [] as string[] };

  it('serializes an empty cell as empty, not as the <br /> placeholder', () => {
    const node = br();
    expect(handler(node, soleChildParagraph(node), inCell)).toBe('');
  });

  it('keeps the placeholder outside tables — it IS the blank line there', () => {
    const node = br();
    expect(handler(node, soleChildParagraph(node), inBody)).toBe('<br />');
  });

  it("keeps an author's inline <br> beside other content in a cell", () => {
    const node = br('<br>');
    const paragraph: MdastNode = { type: 'paragraph', children: [text('a'), node, text('b')] };
    expect(handler(node, paragraph, inCell)).toBe('<br>');
  });

  it('serializes every other html node exactly as the stock handler', () => {
    const node: MdastNode = { type: 'html', value: '<kbd>' };
    expect(handler(node, soleChildParagraph(node), inCell)).toBe('<kbd>');
    expect(handler({ type: 'html' }, undefined, inBody)).toBe('');
  });

  it('peeks < like the stock handler, so escape decisions are unchanged', () => {
    expect(handler.peek()).toBe('<');
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ProjectionSlice } from '@futo-notes/editor/wasm-payloads';
import { chunked, drawLine } from './lineElements';
import { LineModel } from './lineModel';
import { codeHeaderControls } from './codeBlockChrome';
import { edgeLabelShownAt, listenEdgeLabelReveal } from './codeBlockEdgeReveal';

/** One block of one code line `a`, then the paragraph `b`. */
const slice: ProjectionSlice = {
  revision: 0,
  range: { start: 0, end: 3 },
  text: 'a\nb',
  runs: [],
  correspondence: [],
  blocks: [
    {
      range: { start: 0, end: 1 },
      heading: 0,
      quote_depth: 0,
      divider: false,
      list: null,
      code: { line_number: 1, first: true, last: true, mark: null },
      metadata: false,
    },
    {
      range: { start: 2, end: 3 },
      heading: 0,
      quote_depth: 0,
      divider: false,
      list: null,
      code: null,
      metadata: false,
    },
  ],
  links: [],
  wikilinks: [],
  atoms: [],
  tags: [],
  tables: [],
  code_blocks: [{ range: { start: 0, end: 1 }, language: 'js', name: null, line_count: 1 }],
};

describe('an add-a-line label', () => {
  it('shows the label of the edge the pointer is on, until it leaves the editor', () => {
    const model = LineModel.from(slice);
    const elements = model.lines.map((entry) => {
      const element = document.createElement('div');
      drawLine(element, entry);
      return element;
    });
    const editor = document.createElement('div');
    editor.append(...chunked(elements));
    const stop = listenEdgeLabelReveal(editor);
    const [above, below] = elements[0].querySelectorAll<HTMLElement>('.code-edge-label');
    const { name } = codeHeaderControls(elements[0].firstChild as HTMLElement);
    const zone = elements[0].querySelector<HTMLElement>('.code-edge-below')!;
    const over = (target: Element) =>
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const shown = () =>
      [...editor.querySelectorAll('.code-edge-label.shown')].map((label) =>
        label === above ? 'above' : label === below ? 'below' : 'other',
      );

    // Anywhere on the header row, its fields too, shows "above"; the label itself keeps it.
    over(name);
    expect(shown()).toEqual(['above']);
    over(above);
    expect(shown()).toEqual(['above']);
    // The zone below the block, and its label, show "below" alone.
    over(zone);
    expect(shown()).toEqual(['below']);
    over(below);
    expect(shown()).toEqual(['below']);
    // The code row and the paragraph after the block are neither edge.
    over(elements[0]);
    expect(shown()).toEqual([]);
    over(zone);
    over(elements[1]);
    expect(shown()).toEqual([]);
    over(zone);
    editor.dispatchEvent(new MouseEvent('mouseleave'));
    expect(shown()).toEqual([]);
    expect(edgeLabelShownAt(elements[0])).toBeNull();
    stop();
    over(zone);
    expect(shown()).toEqual([]);
  });
});

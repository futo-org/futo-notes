// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ProjectionSlice } from '@futo-notes/editor/wasm-payloads';
import { chunked, drawLine, offsetOf, pointInLine } from './lineElements';
import { LineModel, utf8Length } from './lineModel';
import { codeHeaderControls } from './codeBlockChrome';
import { drawnLineDrift } from './lineDrift';

describe('code lines', () => {
  const codeSlice = (text: string): ProjectionSlice => {
    const [first, second] = text.split('\n');
    const start = utf8Length(first) + 1;
    const code = (isFirst: boolean, last: boolean) => ({
      line_number: 1,
      first: isFirst,
      last,
      mark: null,
    });
    const block = (from: number, to: number, isFirst: boolean, last: boolean) => ({
      range: { start: from, end: to },
      heading: 0,
      quote_depth: 0,
      divider: false,
      list: null,
      code: code(isFirst, last),
      metadata: false,
    });
    return {
      revision: 0,
      range: { start: 0, end: utf8Length(text) },
      text,
      runs: [],
      correspondence: [],
      blocks: [
        block(0, utf8Length(first), true, true),
        block(start, start + utf8Length(second), true, true),
      ],
      links: [],
      wikilinks: [],
      atoms: [],
      tags: [],
      tables: [],
      code_blocks: [
        {
          range: { start: 0, end: utf8Length(first) },
          language: 'js',
          name: 'a.js',
          line_count: 1,
        },
        {
          range: { start, end: start + utf8Length(second) },
          language: null,
          name: null,
          line_count: 1,
        },
      ],
    };
  };

  it("keep a block's chrome out of the text: every offset maps to a DOM point and back", () => {
    const model = LineModel.from(codeSlice('let a\n'));
    const elements = model.lines.map((entry) => {
      const element = document.createElement('div');
      drawLine(element, entry);
      return element;
    });
    const editor = document.createElement('div');
    editor.append(...chunked(elements));
    const [full, empty] = elements;
    const [header, zone] = full.children as unknown as HTMLElement[];
    expect(header.className).toBe('code-header');
    expect(header.getAttribute('data-name')).toBe('a.js');
    expect(header.getAttribute('data-language')).toBe('js');
    // Each one-line block is its own first and last line: its header, then the zone below it.
    expect(zone.className).toBe('code-edge-below');
    // The labels' words are attributes CSS draws, never text.
    const labels = full.querySelectorAll('.code-edge-label');
    expect([...labels].map((label) => label.getAttribute('aria-label'))).toEqual([
      'add a line above',
      'add a line below',
    ]);
    expect(full.textContent).toBe('let a');
    for (let offset = 0; offset <= 5; offset++) {
      expect(offsetOf(editor, model, ...pointInLine(full, offset))).toBe(offset);
    }
    // Before the chrome, between, after it, and in it: the line's start.
    for (const index of [0, 1, 2]) expect(offsetOf(editor, model, full, index)).toBe(0);
    expect(offsetOf(editor, model, header, 0)).toBe(0);
    expect(offsetOf(editor, model, labels[1], 0)).toBe(0);
    // An empty line's point is after its chrome, before its break.
    expect((empty.firstChild as HTMLElement).className).toBe('code-header');
    expect(pointInLine(empty, 0)).toEqual([empty, 2]);
    expect(offsetOf(editor, model, empty, 0)).toBe(6);
    expect(offsetOf(editor, model, empty, 2)).toBe(6);
    expect(offsetOf(editor, model, empty.firstChild!, 0)).toBe(6);
  });

  it('keep the chrome first, and drop each part when the line no longer has it', () => {
    const model = LineModel.from(codeSlice('ab\n'));
    const line = model.lines[0];
    const element = document.createElement('div');
    drawLine(element, line);
    const [header, zone] = element.childNodes;
    drawLine(element, { ...line, text: 'abc' });
    expect([...element.childNodes].slice(0, 2)).toEqual([header, zone]);
    expect(element.textContent).toBe('abc');
    drawLine(element, { ...line, text: 'abc', runs: [{ start: 0, end: 1, formats: ['Bold'] }] });
    expect([...element.childNodes].slice(0, 2)).toEqual([header, zone]);
    expect(element.textContent).toBe('abc');
    drawLine(element, { ...line, text: '' });
    expect([...element.childNodes].slice(0, 2)).toEqual([header, zone]);
    expect(element.lastChild).toBeInstanceOf(HTMLBRElement);
    drawLine(element, { ...line, code: { ...line.code!, first: false } });
    expect([...element.childNodes]).toEqual([zone, element.lastChild]);
    expect(element.textContent).toBe('ab');
    expect(element.className).toBe('line code-line last over-block');
    drawLine(element, { ...line, code: { ...line.code!, last: false } });
    expect(element.firstChild).not.toBe(header);
    expect(element.childNodes.length).toBe(2);
    expect(element.querySelector('.code-edge-below')).toBeNull();
  });

  it("show the block's name and language in the fields, and keep what is typed in a focused one", () => {
    const model = LineModel.from(codeSlice('ab\n'));
    const element = document.createElement('div');
    document.body.append(element);
    drawLine(element, model.lines[0]);
    const header = element.firstChild as HTMLElement;
    const { name, language, copy } = codeHeaderControls(header);
    expect([name.value, language.value]).toEqual(['a.js', 'js']);
    name.focus();
    name.value = 'b.js';
    const renamed = { ...model.lines[0].code!, name: 'c.js', language: 'ts' };
    drawLine(element, { ...model.lines[0], code: renamed });
    expect([name.value, language.value]).toEqual(['b.js', 'ts']);
    // Focus, the caret's block, the copied flash and a shown label are not drawn from the line.
    header.classList.add('active');
    copy.classList.add('copied');
    for (const label of element.querySelectorAll('.code-edge-label')) label.classList.add('shown');
    expect(drawnLineDrift([element], [{ ...model.lines[0], code: renamed }])).toBeNull();
    element.remove();
  });
});

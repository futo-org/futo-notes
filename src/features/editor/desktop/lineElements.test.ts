// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  CHUNK_LINES,
  chunked,
  drawLine,
  holds,
  offsetOf,
  pointInLine,
  redraw,
  settle,
} from './lineElements';
import { NO_GAPS } from './blockNeighbours';
import { LineModel, utf8Length, type FormatRun, type Line, type LineAtom } from './lineModel';
import type {
  AtomDescription,
  BlockDescription,
  ListDescription,
  ProjectionSlice,
} from '@futo-notes/editor/wasm-payloads';

function lines(count: number): HTMLElement[] {
  return Array.from({ length: count }, () => document.createElement('div'));
}

function editorHolding(all: HTMLElement[]): HTMLElement {
  const editor = document.createElement('div');
  editor.append(...chunked(all));
  document.body.replaceChildren(editor);
  return editor;
}

const sizes = (editor: HTMLElement) => [...editor.children].map((chunk) => chunk.children.length);

describe('line chunks', () => {
  it('groups lines in order', () => {
    const all = lines(CHUNK_LINES + 3);
    const editor = editorHolding(all);
    expect(sizes(editor)).toEqual([CHUNK_LINES, 3]);
    expect(holds(editor, all)).toBe(true);
  });

  it('drops a chunk an edit emptied and splits one grown past twice the size', () => {
    const all = lines(2 * CHUNK_LINES);
    const editor = editorHolding(all);
    const [first, second] = editor.children as unknown as HTMLElement[];
    for (const line of [...first.children]) line.remove();
    const pasted = lines(2 * CHUNK_LINES);
    second.lastElementChild!.after(...pasted);
    settle([first, second]);
    expect(sizes(editor)).toEqual([CHUNK_LINES, CHUNK_LINES, CHUNK_LINES]);
    expect(holds(editor, [...all.slice(CHUNK_LINES), ...pasted])).toBe(true);
  });

  it('sees an input method moving a line out of its chunk', () => {
    const all = lines(CHUNK_LINES + 1);
    const editor = editorHolding(all);
    editor.append(all[CHUNK_LINES]);
    expect(holds(editor, all)).toBe(false);
  });
});

describe('DOM points', () => {
  it('read their offset from the line their element was drawn from', () => {
    const text = 'ab\n\ncd';
    const model = LineModel.from({
      revision: 0,
      range: { start: 0, end: text.length },
      text,
      runs: [],
      blocks: [],
      links: [],
      wikilinks: [],
      atoms: [],
      tags: [],
      tables: [],
      code_blocks: [],
    });
    const all = model.lines.map((line) => {
      const element = document.createElement('div');
      drawLine(element, line);
      return element;
    });
    const editor = editorHolding(all);
    const at = (node: Node, offset: number) => offsetOf(editor, model, node, offset);
    expect(at(all[2].firstChild!, 1)).toBe(5);
    expect(at(all[1], 1)).toBe(3);
    expect(at(editor.firstChild!, 2)).toBe(4);
    expect(at(editor, 1)).toBe(model.length);
    expect(at(document.createElement('div'), 0)).toBe(0);
  });
});

describe('formatted lines', () => {
  const line = (text: string, runs: FormatRun[]): Line => ({
    text,
    cr: false,
    start: 10,
    byteStart: 10,
    heading: 0,
    list: null,
    quote: 0,
    divider: false,
    code: null,
    runs,
    atoms: [],
    links: [],
    tags: [],
    metadata: false,
    gaps: NO_GAPS,
  });
  // "ab cd ef": "cd" bold and italic, "ef" code.
  const formatted = (text = 'ab cd ef', cd = 'cd') =>
    line(text, [
      { start: 3, end: 3 + cd.length, formats: ['Bold', 'Italic'] },
      { start: 4 + cd.length, end: text.length, formats: ['Code'] },
    ]);
  const drawn = (element: HTMLElement) =>
    [...element.childNodes].map((node) =>
      node instanceof HTMLElement ? `${node.className}:${node.textContent}` : node.textContent,
    );

  it('draws plain text and one span per run, classed by its formats', () => {
    const element = document.createElement('div');
    drawLine(element, formatted());
    expect(drawn(element)).toEqual(['ab ', 'bold italic:cd', ' ', 'code:ef']);
    drawLine(element, line('plain', []));
    expect(drawn(element)).toEqual(['plain']);
  });

  it('rewrites only the run a keystroke changed', () => {
    const element = document.createElement('div');
    drawLine(element, formatted());
    const [before, cd, space, ef] = [...element.childNodes];
    const cdText = cd.firstChild;
    drawLine(element, formatted('ab cXd ef', 'cXd'));
    expect(drawn(element)).toEqual(['ab ', 'bold italic:cXd', ' ', 'code:ef']);
    const after = [...element.childNodes];
    expect(after).toEqual([before, cd, space, ef]);
    expect(cd.firstChild).toBe(cdText);
  });

  it('heals what an input method changed', () => {
    const element = document.createElement('div');
    drawLine(element, formatted());
    element.childNodes[1].appendChild(document.createTextNode('é'));
    element.append('stray');
    drawLine(element, formatted());
    expect(drawn(element)).toEqual(['ab ', 'bold italic:cd', ' ', 'code:ef']);
  });

  it('maps DOM points and offsets across span edges, both ways', () => {
    const text = 'ab cd ef';
    const model = LineModel.from({
      revision: 0,
      range: { start: 0, end: text.length },
      text,
      runs: [
        { range: { start: 3, end: 5 }, formats: ['Bold'] },
        { range: { start: 6, end: 8 }, formats: ['Code'] },
      ],
      blocks: [],
      links: [],
      wikilinks: [],
      atoms: [],
      tags: [],
      tables: [],
      code_blocks: [],
    });
    const element = document.createElement('div');
    drawLine(element, model.lines[0]);
    const editor = editorHolding([element]);
    const [ab, cd, , ef] = [...element.childNodes];
    const at = (node: Node, offset: number) => offsetOf(editor, model, node, offset);
    // At an edge, the start of the text after it; with `before`, the end of the text before.
    expect(pointInLine(element, 3)).toEqual([cd.firstChild, 0]);
    expect(pointInLine(element, 3, true)).toEqual([ab, 3]);
    expect(pointInLine(element, 0, true)).toEqual([ab, 0]);
    expect(pointInLine(element, 8)).toEqual([ef.firstChild, 2]);
    for (let offset = 0; offset <= text.length; offset++) {
      expect(at(...pointInLine(element, offset))).toBe(offset);
      expect(at(...pointInLine(element, offset, true))).toBe(offset);
    }
    // Points on the line and on a span, as a hit-test can give them.
    expect(at(element, 1)).toBe(3);
    expect(at(element, 4)).toBe(8);
    expect(at(cd, 0)).toBe(3);
    expect(at(cd, 1)).toBe(5);
  });

  it('maps a surrogate pair and an empty line', () => {
    const element = document.createElement('div');
    drawLine(element, line('😀x', [{ start: 0, end: 2, formats: ['Strike'] }]));
    expect(pointInLine(element, 2)).toEqual([element.lastChild, 0]);
    expect(pointInLine(element, 2, true)).toEqual([element.firstChild!.firstChild, 2]);
    drawLine(element, line('', []));
    expect(pointInLine(element, 0)).toEqual([element, 0]);
  });
});

const item = (fields: Partial<ListDescription> = {}): ListDescription => ({
  indent: 0,
  level: 0,
  marker: '-',
  ordered: false,
  checked: null,
  first: true,
  ...fields,
});
const MARKER = '\uFFFC';
const markerAtom: LineAtom = { kind: 'ListMarker', start: 0, end: 1, image: null };
/** One projection slice of `lines`, each a list item's text after its marker: one block and one
 *  marker atom each, in display bytes. */
function listSlice(lines: { text: string; list: ListDescription }[]): ProjectionSlice {
  const blocks: BlockDescription[] = [];
  const atoms: AtomDescription[] = [];
  let at = 0;
  for (const { text, list } of lines) {
    const end = at + utf8Length(MARKER + text);
    blocks.push({
      range: { start: at, end },
      heading: 0,
      quote_depth: 0,
      divider: false,
      list,
      code: false,
      language: null,
      metadata: false,
    });
    atoms.push({
      kind: 'ListMarker',
      range: { start: at, end: at + 3 },
      before: 0,
      after: 0,
      image: null,
    });
    at = end + 1;
  }
  const text = lines.map((line) => MARKER + line.text).join('\n');
  return {
    revision: 0,
    range: { start: 0, end: utf8Length(text) },
    text,
    runs: [],
    correspondence: [],
    blocks,
    links: [],
    wikilinks: [],
    atoms,
    tags: [],
    tables: [],
    code_blocks: [],
  };
}

describe('block lines', () => {
  const line = (text: string, fields: Partial<Line> = {}): Line => ({
    text,
    cr: false,
    start: 0,
    byteStart: 0,
    heading: 0,
    list: null,
    quote: 0,
    divider: false,
    code: null,
    runs: [],
    atoms: [],
    links: [],
    tags: [],
    metadata: false,
    gaps: NO_GAPS,
    ...fields,
  });
  const drawn = (fields: Partial<Line>, text = 'x') => {
    const element = document.createElement('div');
    drawLine(element, line(text, fields));
    return element;
  };
  const listed = (list: ListDescription, text = 'x', fields: Partial<Line> = {}) =>
    drawn({ list, atoms: [markerAtom], ...fields }, MARKER + text);

  it('carries its block as classes', () => {
    expect(listed(item({ level: 1 })).className).toBe('line list d2');
    expect(listed(item({ marker: '12)', ordered: true }), 'x', { quote: 1 }).className).toBe(
      'line list d1 ordered quote q1',
    );
    // An indented plain line starts where the marker of the level it borrows would.
    expect(drawn({ list: item({ marker: '', indent: 2, level: 1 }) }).className).toBe(
      'line list d1',
    );
    expect(drawn({ list: item({ marker: '', indent: 2 }) }).className).toBe('line');
    expect(drawn({ quote: 9 }).className).toBe('line quote q6');
    expect(drawn({ divider: true }, MARKER).className).toBe('line divider');
  });

  it("gives an ordered item's line its marker's measured width", () => {
    // jsdom has no canvas: one that gives every character 10px.
    const editor = document.body.appendChild(document.createElement('div'));
    editor.className = 'desktop-editor';
    const context = { font: '', measureText: (text: string) => ({ width: text.length * 10 }) };
    const canvas = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as unknown as CanvasRenderingContext2D);
    try {
      const wide = listed(item({ ordered: true, marker: '100.' }));
      expect(wide.style.getPropertyValue('--marker-width')).toBe('40px');
      expect(drawn({}).style.getPropertyValue('--marker-width')).toBe('');
      expect(listed(item({ marker: '-' })).style.getPropertyValue('--marker-width')).toBe('');
    } finally {
      canvas.mockRestore();
      editor.remove();
    }
  });

  it("draws a list item's marker as an element holding its one character", () => {
    const parts = (element: HTMLElement) =>
      [...element.childNodes].map((node) =>
        node instanceof HTMLElement
          ? `${node.tagName}.${node.className}${node.dataset.marker ? `[${node.dataset.marker}]` : ''}:${node.textContent}`
          : node.textContent,
      );
    expect(parts(listed(item()))).toEqual([`SPAN.atom marker bullet:${MARKER}`, 'x']);
    expect(parts(listed(item({ marker: '12)', ordered: true }), 'twelve'))).toEqual([
      `SPAN.atom marker ordered[12)]:${MARKER}`,
      'twelve',
    ]);
    // An item with no text keeps its row with a break.
    expect(parts(listed(item(), ''))).toEqual([`SPAN.atom marker bullet:${MARKER}`, 'BR.:']);
    // A divider's character is an atom's element too, and a run after a marker its span.
    expect(
      parts(
        drawn(
          {
            divider: true,
            atoms: [{ ...markerAtom, kind: 'Divider' }],
          },
          MARKER,
        ),
      ),
    ).toEqual([`SPAN.atom divider:${MARKER}`]);
    const bold = listed(item(), 'ab', { runs: [{ start: 1, end: 3, formats: ['Bold'] }] });
    expect(parts(bold)).toEqual([`SPAN.atom marker bullet:${MARKER}`, 'SPAN.bold:ab']);
    // The marker's text follows the engine's description, in place.
    const element = listed(item({ marker: '9.', ordered: true }));
    const marker = element.firstChild;
    drawLine(
      element,
      line(MARKER + 'x', { list: item({ marker: '10.', ordered: true }), atoms: [markerAtom] }),
    );
    expect(element.firstChild).toBe(marker);
    expect(parts(element)).toEqual([`SPAN.atom marker ordered[10.]:${MARKER}`, 'x']);
    drawLine(element, line('plain'));
    expect(parts(element)).toEqual(['plain']);
  });

  it('maps every offset of a list line to a DOM point and back', () => {
    const model = LineModel.from(
      listSlice([
        { text: 'buy milk', list: item() },
        { text: '', list: item() },
      ]),
    );
    const elements = model.lines.map((entry) => {
      const element = document.createElement('div');
      drawLine(element, entry);
      return element;
    });
    const editor = editorHolding(elements);
    const [full, empty] = elements;
    const marker = full.firstChild!.firstChild!;
    // Before the marker, inside its character; after it, the text's start.
    expect(pointInLine(full, 0)).toEqual([marker, 0]);
    expect(pointInLine(full, 1)).toEqual([full.lastChild, 0]);
    for (let offset = 0; offset <= 9; offset++) {
      expect(offsetOf(editor, model, ...pointInLine(full, offset))).toBe(offset);
    }
    // After the marker of an item with no text: after the marker's element, before the break.
    expect(pointInLine(empty, 0)).toEqual([empty.firstChild!.firstChild, 0]);
    expect(pointInLine(empty, 1)).toEqual([empty, 1]);
    expect(offsetOf(editor, model, empty, 1)).toBe(11);
    expect(offsetOf(editor, model, empty.firstChild!, 1)).toBe(11);
  });

  it("gives a task's marker the checkbox's role, name and state", () => {
    const element = listed(item({ checked: true }), 'buy milk');
    const box = element.firstChild as HTMLElement;
    expect(box.className).toBe('atom marker task-box');
    expect(box.getAttribute('role')).toBe('checkbox');
    expect(box.getAttribute('aria-checked')).toBe('true');
    expect(box.getAttribute('aria-label')).not.toBeNull();
    expect(box.textContent).toBe(MARKER);
    expect(element.className).toBe('line list d1 task');
    drawLine(element, line(MARKER, { list: item({ checked: false }), atoms: [markerAtom] }));
    expect(element.firstChild).toBe(box);
    expect(box.getAttribute('aria-checked')).toBe('false');
    drawLine(element, line(MARKER, { list: item(), atoms: [markerAtom] }));
    expect(element.firstChild).not.toBe(box);
    expect((element.firstChild as HTMLElement).getAttribute('role')).toBeNull();
  });
});

describe('redrawn lines', () => {
  it('redraws only the lines whose description or text changed', () => {
    const ordered = (number: number) => item({ marker: `${number}.`, ordered: true });
    const model = LineModel.from(
      listSlice([
        { text: 'a', list: ordered(1) },
        { text: 'b', list: ordered(2) },
        { text: 'c', list: ordered(3) },
      ]),
    );
    const elements = model.lines.map((entry) => {
      const element = document.createElement('div');
      drawLine(element, entry);
      return element;
    });
    editorHolding(elements);
    const changed: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changed.push(...records));
    for (const element of elements) {
      observer.observe(element, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    // Enter at the end of "a": a new item 2, and "b" and "c" renumbered; the engine's
    // projection restyles every line.
    const projection = listSlice([
      { text: 'a', list: ordered(1) },
      { text: '', list: ordered(2) },
      { text: 'b', list: ordered(3) },
      { text: 'c', list: ordered(4) },
    ]);
    const splice = model.splice({
      previous_revision: 0,
      revision: 1,
      range: { start: 4, end: 4 },
      inserted: `\n${MARKER}`,
      selection: { start: 8, end: 8 },
      work: {
        materialized_source_bytes: 0,
        inserted_bytes: 0,
        parsed_source_bytes: 0,
        link_metadata_items: 0,
        link_copied_bytes: 0,
      },
      affinity: 'Forward',
      projection,
    });
    redraw(elements, model, splice);
    changed.push(...observer.takeRecords());
    observer.disconnect();
    const markers = elements.map((element) => (element.firstChild as HTMLElement).dataset.marker);
    expect(markers).toEqual(['1.', '2.', '3.', '4.']);
    // "a" is untouched; "b" and "c" changed only their marker, not their text.
    const touched = (index: number) =>
      changed.filter((record) => elements[index].contains(record.target));
    expect(touched(0)).toEqual([]);
    for (const index of [2, 3]) {
      expect(touched(index).map((record) => record.attributeName)).toEqual(['data-marker']);
    }
  });
});

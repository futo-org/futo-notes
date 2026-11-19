import { describe, expect, it } from 'vitest';
import type {
  AtomDescription,
  AtomKind,
  BlockDescription,
  DisplayRange,
  ProjectionSlice,
  SemanticRun,
  ViewChange,
} from '@futo-notes/editor/wasm-payloads';
import { LineModel, utf8Length } from './lineModel';

function block(start: number, end: number, heading = 0): BlockDescription {
  return {
    range: { start, end },
    heading,
    quote_depth: 0,
    divider: false,
    list: null,
    code: null,
    metadata: false,
  };
}

function slice(
  text: string,
  blocks: BlockDescription[],
  start = 0,
  runs: SemanticRun[] = [],
): ProjectionSlice {
  return {
    revision: 0,
    range: { start, end: start + utf8Length(text) },
    text,
    runs,
    blocks,
    links: [],
    wikilinks: [],
    atoms: [],
    tags: [],
    tables: [],
    code_blocks: [],
  };
}

function change(
  start: number,
  end: number,
  inserted: string,
  projection: ProjectionSlice,
): ViewChange {
  return {
    previous_revision: 0,
    revision: 1,
    range: { start, end },
    inserted,
    selection: { start: start + utf8Length(inserted), end: start + utf8Length(inserted) },
    work: {
      materialized_source_bytes: 0,
      inserted_bytes: 0,
      parsed_source_bytes: 0,
      link_metadata_items: 0,
      link_copied_bytes: 0,
    },
    affinity: 'Backward',
    projection,
  };
}

const texts = (model: LineModel) => model.lines.map((line) => line.text);

// The engine's own projection of `# Title\nbody\n\npara` (one block per display line).
const opened = () =>
  LineModel.from(
    slice('Title\nbody\n\npara', [block(0, 5, 1), block(6, 10), block(11, 11), block(12, 16)]),
  );

describe('LineModel', () => {
  it('splits the display into lines with headings', () => {
    const model = opened();
    expect(texts(model)).toEqual(['Title', 'body', '', 'para']);
    expect(model.lines.map((line) => line.heading)).toEqual([1, 0, 0, 0]);
    expect(model.lines.map((line) => line.start)).toEqual([0, 6, 11, 12]);
  });

  it('converts between UTF-16 and UTF-8 offsets across multibyte text', () => {
    const model = LineModel.from(slice('é😀\nx', [block(0, 6), block(7, 8)]));
    expect(model.toByte(1)).toBe(2);
    expect(model.toByte(3)).toBe(6);
    expect(model.toUtf16(6)).toBe(3);
    expect(model.toUtf16(7)).toBe(4);
    expect(model.length).toBe(5);
  });

  it('keeps a CRLF line ending out of the drawn text and the caret out of the CR', () => {
    const model = LineModel.from(slice('ab\r\ncd', [block(0, 3), block(4, 6)]));
    expect(texts(model)).toEqual(['ab', 'cd']);
    expect(model.lines[1].start).toBe(4);
  });

  it('ends a line at a lone CR, as the engine does', () => {
    const model = LineModel.from(slice('a\rb\r\nc', [block(0, 1, 1), block(2, 3), block(5, 6)]));
    expect(texts(model)).toEqual(['a', 'b', 'c']);
    expect(model.lines.map((line) => [line.start, line.cr, line.heading])).toEqual([
      [0, false, 1],
      [2, true, 0],
      [5, false, 0],
    ]);
    // Deleting the lone CR joins the two lines.
    model.splice(change(1, 2, '', slice('ab', [block(0, 2, 1)])));
    expect(texts(model)).toEqual(['ab', 'c']);
    expect(model.lines[1].start).toBe(4);
  });

  it('applies a keystroke inside one line and shifts the lines after it', () => {
    const model = opened();
    const splice = model.splice(change(8, 8, 'X', slice('boXdy', [block(6, 11)], 6)));
    expect(splice).toEqual({
      first: 1,
      removed: 1,
      added: 1,
      restyled: [1, 2],
      widened: null,
      guessed: [],
    });
    expect(texts(model)).toEqual(['Title', 'boXdy', '', 'para']);
    expect(model.lines.map((line) => line.start)).toEqual([0, 6, 12, 13]);
    expect(model.lines[3].byteStart).toBe(13);
  });

  it('splits a line on a newline and joins lines on a deletion across them', () => {
    const model = opened();
    model.splice(change(8, 8, '\n', slice('bo\ndy', [block(6, 8), block(9, 11)], 6)));
    expect(texts(model)).toEqual(['Title', 'bo', 'dy', '', 'para']);
    model.splice(change(5, 9, '', slice('Titledy', [block(0, 7, 1)])));
    expect(texts(model)).toEqual(['Titledy', '', 'para']);
    expect(model.lines[0].heading).toBe(1);
    expect(model.lines[2].start).toBe(9);
  });

  it('keeps the style of a line that starts where the reparsed slice ends', () => {
    // `# Heading` pushed down by Enters: the engine reparses only the lines above it.
    const model = LineModel.from(slice('\n\nHeading', [block(0, 0), block(1, 1), block(2, 9, 1)]));
    model.splice(change(0, 0, 'I', slice('I\n\n', [block(0, 1), block(2, 2)])));
    expect(model.lines.map((line) => [line.text, line.heading])).toEqual([
      ['I', 0],
      ['', 0],
      ['Heading', 1],
    ]);
  });

  it('makes the line an Enter adds after a heading body text', () => {
    // `# Title` with the caret at its end: the engine reparses only the heading.
    const model = LineModel.from(slice('Title', [block(0, 5, 1)]));
    model.splice(change(5, 5, '\n', slice('Title', [block(0, 5, 1)])));
    expect(model.lines.map((line) => [line.text, line.heading])).toEqual([
      ['Title', 1],
      ['', 0],
    ]);
  });

  it("takes a CRLF's CR apart from its LF, and puts it back", () => {
    // Enter over `ab\r\n` writes the break as `\n`: the change takes `ab\r` and keeps the `\n`;
    // its Undo puts `ab\r` back before that `\n`.
    const model = LineModel.from(slice('ab\r\nc', [block(0, 3), block(4, 5)]));
    model.splice(change(0, 3, '', slice('\nc', [block(0, 0), block(1, 2)])));
    expect(model.lines.map(({ text, cr, byteStart }) => [text, cr, byteStart])).toEqual([
      ['', false, 0],
      ['c', false, 1],
    ]);
    model.splice(change(0, 0, 'ab\r', slice('ab\r\nc', [block(0, 3), block(4, 5)])));
    expect(model.lines.map(({ text, cr, byteStart }) => [text, cr, byteStart])).toEqual([
      ['ab', true, 0],
      ['c', false, 4],
    ]);
  });

  it('draws an empty CRLF line as empty, its hidden CR aside', () => {
    const model = LineModel.from(slice('h\r\n\r\nx', [block(0, 2, 1), block(3, 4), block(5, 6)]));
    expect(texts(model)).toEqual(['h', '', 'x']);
  });

  it('restyles lines the engine reinterprets outside the edited one', () => {
    const model = opened();
    // Typing turned line 2 into a heading: the engine's projection says so.
    model.splice(change(6, 6, '', slice('body', [block(6, 10, 2)], 6)));
    expect(model.lines[1].heading).toBe(2);
  });
});

describe('LineModel lines the projection missed', () => {
  /** The engine's reading of display bytes, as `Engine.project` gives it: `text` from `start`. */
  const engineReading = (
    expected: DisplayRange,
    reading: ProjectionSlice,
  ): ((range: DisplayRange) => ProjectionSlice) => {
    return (range: DisplayRange): ProjectionSlice => {
      expect(range).toEqual(expected);
      return reading;
    };
  };

  it('reports a rebuilt line its projection missed, and reads it from the engine', () => {
    // Backspace on the empty line of `para\n\n# Title **bold**`: the engine names the later of
    // the two equal line breaks (5..6) and reprojects only `para`.
    const bold: SemanticRun = { range: { start: 12, end: 16 }, formats: ['Bold'] };
    const model = LineModel.from(
      slice('para\n\nTitle bold', [block(0, 4), block(5, 5), block(6, 16, 1)], 0, [bold]),
    );
    const splice = model.splice(change(5, 6, '', slice('para\n', [block(0, 4)])));
    expect(splice).toMatchObject({ first: 1, removed: 2, added: 1 });
    expect(splice.guessed).toEqual([model.lines[1]]);
    const reading = slice('Title bold', [block(5, 15, 1)], 5, [
      { range: { start: 11, end: 15 }, formats: ['Bold'] },
    ]);
    expect(
      model.describeLines(splice.guessed, engineReading({ start: 5, end: 15 }, reading)),
    ).toEqual([1, 2]);
    expect(model.lines[1]).toMatchObject({
      text: 'Title bold',
      start: 5,
      heading: 1,
      runs: [{ start: 6, end: 10, formats: ['Bold'] }],
    });
  });

  it('describes only the guessed lines a later change kept', () => {
    const model = opened();
    const splice = model.splice(change(8, 8, '\n', slice('bo', [block(6, 8)], 6)));
    expect(splice.guessed.map((line) => line.text)).toEqual(['dy']);
    // A second change replaced `dy`: nothing is left to describe.
    model.splice(change(9, 11, 'xy', slice('xy', [block(9, 11)], 9)));
    expect(model.describeLines(splice.guessed, () => expect.fail('nothing to read'))).toBeNull();
  });
});

describe('LineModel runs and blocks', () => {
  it("keeps each line's formatted runs, clipped to it, in its UTF-16 units", () => {
    // `a **b\nc** é*😀*`: a plain run and a bold run across the line break, then italic
    // after multibyte text.
    const runs: SemanticRun[] = [
      { range: { start: 0, end: 2 }, formats: [] },
      { range: { start: 2, end: 5 }, formats: ['Bold'] },
      { range: { start: 5, end: 8 }, formats: [] },
      { range: { start: 8, end: 12 }, formats: ['Italic'] },
    ];
    const model = LineModel.from(slice('a b\nc é😀', [block(0, 3), block(4, 12)], 0, runs));
    expect(model.lines.map((line) => line.runs)).toEqual([
      [{ start: 2, end: 3, formats: ['Bold'] }],
      [
        { start: 0, end: 1, formats: ['Bold'] },
        { start: 3, end: 5, formats: ['Italic'] },
      ],
    ]);
  });

  it('keeps a run ending at a CRLF out of its hidden CR', () => {
    const runs: SemanticRun[] = [{ range: { start: 1, end: 4 }, formats: ['Code'] }];
    const model = LineModel.from(slice('ab\r\ncd', [block(0, 3), block(4, 6)], 0, runs));
    expect(model.lines.map((line) => line.runs)).toEqual([
      [{ start: 1, end: 2, formats: ['Code'] }],
      [],
    ]);
  });

  it("takes a keystroke's runs from its projection, and plain lines share no runs", () => {
    const model = opened();
    expect(model.lines[3].runs).toEqual([]);
    // Typing in "body" made "oX" bold (the engine's projection of the reparsed line).
    model.splice(
      change(
        8,
        8,
        'X',
        slice('boXdy', [block(6, 11)], 6, [
          { range: { start: 7, end: 9 }, formats: ['Bold', 'Strike'] },
        ]),
      ),
    );
    expect(model.lines[1].runs).toEqual([{ start: 1, end: 3, formats: ['Bold', 'Strike'] }]);
    expect(model.lines[0].runs).toBe(model.lines[3].runs);
  });

  it("takes each line's list, quote and divider from its block", () => {
    const list = { indent: 2, level: 1, marker: '3.', ordered: true, checked: false, first: true };
    const model = LineModel.from(
      slice('item\nq\n\uFFFC\nplain', [
        { ...block(0, 4), list },
        { ...block(5, 6), quote_depth: 2 },
        { ...block(7, 10), divider: true },
        block(11, 16),
      ]),
    );
    expect(model.lines.map(({ list, quote, divider }) => [list, quote, divider])).toEqual([
      [list, 0, false],
      [null, 2, false],
      [null, 0, true],
      [null, 0, false],
    ]);
  });

  it("takes each code line's place in its block, the block's header on its first line, and the blocks it touches", () => {
    const code = (first: boolean, last: boolean) => ({ line_number: 1, first, last, mark: null });
    const model = LineModel.from({
      ...slice('a\nb\nc\nd', [
        { ...block(0, 1), code: code(true, false) },
        { ...block(2, 3), code: code(false, true) },
        { ...block(4, 5), code: code(true, true) },
        block(6, 7),
      ]),
      tables: [],
      code_blocks: [
        { range: { start: 0, end: 3 }, language: 'Rust', name: 'a.rs', line_count: 2 },
        { range: { start: 4, end: 5 }, language: null, name: null, line_count: 100 },
      ],
    });
    const placed = (first: boolean, last: boolean, digits: number) => ({
      first,
      last,
      digits,
      language: null,
      name: null,
      underBlock: false,
      overBlock: false,
    });
    expect(model.lines.map((line) => line.code)).toEqual([
      { ...placed(true, false, 2), language: 'Rust', name: 'a.rs' },
      { ...placed(false, true, 2), overBlock: true },
      { ...placed(true, true, 3), underBlock: true },
      null,
    ]);
  });

  it("takes each line's atoms from the projection, in its UTF-16 units", () => {
    // `- é` / `---` / `1. 😀x`: the markers and the divider are one U+FFFC each (3 bytes).
    const atom = (kind: AtomKind, start: number): AtomDescription => ({
      kind,
      range: { start, end: start + 3 },
      before: 0,
      after: 0,
      image: null,
    });
    const text = '\uFFFCé\n\uFFFC\n\uFFFC😀x';
    const model = LineModel.from({
      ...slice(text, [block(0, 5), { ...block(6, 9), divider: true }, block(10, 18)]),
      atoms: [atom('ListMarker', 0), atom('Divider', 6), atom('ListMarker', 10)],
    });
    expect(model.lines.map((line) => line.atoms)).toEqual([
      [{ kind: 'ListMarker', start: 0, end: 1, image: null }],
      [{ kind: 'Divider', start: 0, end: 1, image: null }],
      [{ kind: 'ListMarker', start: 0, end: 1, image: null }],
    ]);
    // Typing before the marker made the line plain: its projection has no atom left on it.
    model.splice(change(0, 0, 'a', slice('a\uFFFCé', [block(0, 6)])));
    expect(model.lines[0].atoms).toEqual([]);
    expect(model.lines[2].atoms).toEqual([{ kind: 'ListMarker', start: 0, end: 1, image: null }]);
  });
});

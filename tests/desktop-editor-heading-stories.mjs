// The desktop editor's rows in body text and headings: the four inline formats drawn from the
// engine's runs (lineElements.ts `drawLine`) in both, read back through `show {"text"}`'s
// `formats`; a first-level heading's rows 30px and a second-level one's 28px, with no space
// around a heading (desktopEditor.css), and Up, Down and a selection across a heading.
// Content comes in through Paste.
// `node tests/desktop-editor-heading-stories.mjs [filter]` runs the stories whose name holds it.
import assert from 'node:assert/strict';
import {
  act,
  assertNear,
  finish,
  FORMATS_NOTE,
  inScratchNote,
  lineAndBandsAt,
  pasted,
  read,
  rowMiddleOf,
  shownText,
  story,
} from './lib/desktop-editor-story.mjs';

/** A first-level heading's row and a second-level one's, px (desktopEditor.css). */
const H1_ROW = 30;
const H2_ROW = 28;

await story(
  'the four formats draw in body text and headings, inline code keeping its row height',
  () =>
    inScratchNote(async () => {
      pasted(FORMATS_NOTE);
      for (const [text, formats] of [
        ['big', ['bold']],
        ['lean', ['italic']],
        ['old', ['strike']],
        ['mono', ['code']],
        ['bold', ['bold']],
        ['ital', ['italic']],
        ['gone', ['strike']],
        ['code', ['code']],
        ['both', ['bold+italic']],
        ['plain bold', ['plain', 'bold']],
        ['a plain line', ['plain']],
      ]) {
        assert.deepEqual(shownText(text).formats, formats, `"${text}"`);
      }
      // Inline code changes neither the row's height nor where the text beside it sits.
      const code = lineAndBandsAt(shownText('plain').rect.x + 1, rowMiddleOf('plain'));
      const plain = lineAndBandsAt(shownText('a plain').rect.x + 1, rowMiddleOf('a plain'));
      assertNear(code.line.h, plain.line.h, 'a row holding inline code');
      assertNear(
        shownText('plain').rect.y - code.line.y,
        shownText('a plain').rect.y - plain.line.y,
        'baseline',
      );
      // A first-level heading holding inline code: one row, its text in the row's middle.
      const head = lineAndBandsAt(shownText('Head').rect.x + 1, rowMiddleOf('Head')).line;
      assertNear(head.h, H1_ROW, 'a heading line holding inline code');
      assertNear(rowMiddleOf('Head') - head.y, H1_ROW / 2, "a heading's text: its row's middle");
    }),
);

/** The line element `text` shows in. */
const lineOf = (text) => lineAndBandsAt(shownText(text).rect.x + 1, rowMiddleOf(text)).line;

await story('heading rows are 1.25 times their font, with no space around a heading', () =>
  inScratchNote(async () => {
    const long = 'a first level heading long enough to wrap '.repeat(6).trim();
    pasted(`# One\n## Two\nunder two\n### Three\nunder three\n# ${long}\nafter`);
    const one = lineOf('One');
    const two = lineOf('Two');
    const three = lineOf('Three');
    assertNear(one.h, H1_ROW, 'a first-level heading row');
    assertNear(two.h, H2_ROW, 'a second-level heading row');
    assertNear(three.h, 24, 'a third-level heading row: one line unit');
    assertNear(rowMiddleOf('One') - one.y, H1_ROW / 2, "a first-level heading's text centred");
    assertNear(rowMiddleOf('Two') - two.y, H2_ROW / 2, "a second-level heading's text centred");
    // Each line starts where the one above ends.
    assertNear(two.y, one.y + one.h, 'under a first-level heading');
    assertNear(lineOf('under two').y, two.y + two.h, 'under a second-level heading');
    assertNear(lineOf('under three').y, three.y + three.h, 'under a third-level heading');
    // A wrapped first-level heading: a whole number of its rows, two or more.
    const wrapped = lineOf('first level');
    const rows = Math.round(wrapped.h / H1_ROW);
    assert.ok(rows >= 2, `the long heading wraps: ${wrapped.h}px`);
    assertNear(wrapped.h, rows * H1_ROW, 'a wrapped first-level heading');
    assertNear(lineOf('after').y, wrapped.y + wrapped.h, 'under a wrapped heading');
  }),
);

await story('Up, Down and a selection cross a heading as one line', () =>
  inScratchNote(async () => {
    pasted(FORMATS_NOTE.replace('a plain line', '## Two\nunder two'));
    // Down from each heading lands on the line under it, and Up comes back.
    act('do', 'PlaceCaret', { at: 0 });
    const line = () => read('state').editor.selection.line;
    for (const expected of [2, 3, 4]) {
      act('press', { key: 'ArrowDown' });
      assert.equal(line(), expected, `Down to line ${expected}`);
    }
    for (const expected of [3, 2, 1]) {
      act('press', { key: 'ArrowUp' });
      assert.equal(line(), expected, `Up to line ${expected}`);
    }
    // From inside the heading into the line under it: the heading's band meets the next line's.
    const plainRow = lineOf('plain');
    act('do', 'Select', { from: 3, to: 26 });
    const x = shownText('big').rect.x + 2;
    const [headBand] = lineAndBandsAt(x, rowMiddleOf('Head')).bands.map((band) => JSON.parse(band));
    assert.ok(headBand, 'a band on the heading');
    assertNear(headBand.y + headBand.h, plainRow.y, "the heading's band meets the next line's");
  }),
);

finish('desktop editor heading stories');

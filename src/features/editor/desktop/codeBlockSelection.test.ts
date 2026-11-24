import { beforeAll, expect, it } from 'vitest';
import { Engine } from './engine';
import { LineModel } from './lineModel';
import {
  fitSelectionToCodeBlocks,
  codeBlockLinesAt,
  isBlockTakenWhole,
} from './codeBlockSelection';
import { loadEngineBuild } from './__test__/loadEngineBuild';

beforeAll(loadEngineBuild);

/** For each selection, whether the page draws the block taken whole, and whether the engine
 *  takes it whole: its copy carries the fences. The notes are ASCII: bytes are UTF-16 units. */
async function readings(
  source: string,
  codeLine: number,
  ranges: Array<[number, number]>,
): Promise<Array<[string, boolean, boolean]>> {
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  const model = LineModel.from(engine.projectAll());
  const block = codeBlockLinesAt(model.lines, codeLine);
  const found = ranges.map(([start, end]): [string, boolean, boolean] => [
    `${start}..${end}`,
    isBlockTakenWhole({ start, end }, block, model.length),
    engine.copy({ start, end }).includes('```'),
  ]);
  engine.free();
  return found;
}

// Display text "above\nab\ncd\nbelow": the code is 6..11, the line after it starts at 12.
it('draws a block whole for exactly the selections the engine takes it whole for', async () => {
  const found = await readings('above\n```\nab\ncd\n```\nbelow', 2, [
    [6, 11],
    [7, 12],
    [2, 6],
    [11, 15],
    [2, 7],
    [7, 13],
    [0, 17],
  ]);
  for (const [range, drawn, taken] of found) expect(drawn, range).toBe(taken);
  expect(found.map(([, drawn]) => drawn)).toEqual([false, true, false, false, true, true, true]);
});

it('draws an empty block whole for a selection from it, or reaching it at the note end', async () => {
  const found = await readings('above\n```\n```', 1, [
    [0, 6],
    [0, 5],
  ]);
  for (const [range, drawn, taken] of found) expect(drawn, range).toBe(taken);
  expect(found.map(([, drawn]) => drawn)).toEqual([true, false]);
});

// Display text "ab\ncd\nq": the lower block's code is 3..5; "above\n\nbelow": the empty one at 6.
it('draws the lower of two touching blocks, and an empty one, whole as the engine takes them', async () => {
  const touching = await readings('```\nab\n```\n```\ncd\n```\nq', 1, [
    [3, 7],
    [3, 6],
  ]);
  const empty = await readings('above\n```\n```\nbelow', 1, [[6, 7]]);
  for (const [range, drawn, taken] of [...touching, ...empty]) expect(drawn, range).toBe(taken);
  expect([...touching, ...empty].map(([, drawn]) => drawn)).toEqual([true, true, true]);
});

/** Each [anchor, focus] as the selection the user makes from it, [anchor, focus]. */
async function clamped(
  source: string,
  ends: Array<[number, number]>,
): Promise<Array<[number, number]>> {
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  const model = LineModel.from(engine.projectAll());
  engine.free();
  return ends.map(([anchor, focus]) => {
    const kept = fitSelectionToCodeBlocks(model, { anchor, focus });
    return [kept.anchor, kept.focus];
  });
}

// Display text "above\nab\ncd\nbelow\nef": the first block's code is 6..11, the second's 18..20.
// From below, a focus at the code's end holds only the line break after the block, which the
// engine does not take the block for (11..15 above): it starts past that break.
it('keeps a selection anchored in code in that code, and one from below off the break after it', async () => {
  const ends: Array<[number, number]> = [
    [7, 0],
    [7, 15],
    [7, 19],
    [7, 9],
    [6, 2],
    [11, 15],
    [11, 7],
    [2, 9],
    [15, 7],
    [19, 9],
    [15, 11],
    [12, 11],
    [15, 10],
    [2, 6],
  ];
  const found = await clamped('above\n```\nab\ncd\n```\nbelow\n```\nef\n```', ends);
  expect(found).toEqual([
    [7, 6],
    [7, 11],
    [7, 11],
    [7, 9],
    [6, 6],
    [11, 11],
    [11, 7],
    [2, 9],
    [15, 7],
    [19, 18],
    [15, 12],
    [12, 12],
    [15, 10],
    [2, 6],
  ]);
  expect(await clamped('above\n```\nab\ncd\n```\nbelow\n```\nef\n```', found)).toEqual(found);
  expect(await clamped('above\n```\nab\n```', [[8, 0]])).toEqual([[8, 6]]);
});

// Display text "ab\ncd\nq": the touching blocks' code is 0..2 and 3..5.
it('starts a selection from below the lower of two touching blocks past the upper one', async () => {
  expect(
    await clamped('```\nab\n```\n```\ncd\n```\nq', [
      [7, 2],
      [6, 2],
      [7, 5],
    ]),
  ).toEqual([
    [7, 3],
    [6, 3],
    [7, 6],
  ]);
});

it('leaves an empty block, and the whole note from a block that opens it, as they are', async () => {
  expect(
    await clamped('above\n```\n```\nbelow', [
      [6, 0],
      [12, 6],
      [7, 6],
    ]),
  ).toEqual([
    [6, 0],
    [12, 6],
    [7, 6],
  ]);
  expect(
    await clamped('```\nab\n```\nbelow', [
      [0, 8],
      [0, 5],
    ]),
  ).toEqual([
    [0, 8],
    [0, 2],
  ]);
});

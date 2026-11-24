// @vitest-environment jsdom
/* A differential test on the real engine: random inputs, and after each one the page's lines
 * and line elements must be what a fresh read of the whole note draws, fenced code blocks
 * included (a line's place in its block, its header and its gutter's width), and tables (a
 * line's place in its table, its cells and its table's columns). More seeds:
 * DESKTOP_EDITOR_DIFFERENTIAL_SEEDS=<count>. */
import { beforeAll, expect, it } from 'vitest';
import type {
  Applied,
  BlockCommand,
  InlineFormat,
  ParagraphKey,
} from '@futo-notes/editor/wasm-payloads';
import { Engine } from './engine';
import { LineModel } from './lineModel';
import { chunked, drawLine, holds } from './lineElements';
import { atomElementsOf } from './atomElements';
import { lineModelDrift, drawnLineDrift } from './lineDrift';
import { applyViewChanges } from './applyViewChanges';
import { loadEngineBuild } from './__test__/loadEngineBuild';

type Span = [number, number];

/** One input, in the page's UTF-16 display offsets, replayable as written. */
type Operation =
  | { type: 'type'; at: Span; text: string }
  | { type: 'typeAtCaret'; text: string }
  | { type: 'key'; at: Span; key: ParagraphKey }
  | { type: 'block'; at: Span; command: BlockCommand }
  | { type: 'format'; at: Span; format: InlineFormat; text: string }
  | { type: 'paste'; at: Span; text: string }
  | { type: 'cut'; at: Span }
  | { type: 'move'; at: Span; to: number }
  | { type: 'undo' }
  | { type: 'redo' };

const SOURCES = [
  'para\n\n88888) five wide digits\nend',
  '- a\n\n- b',
  '# Title\n\n\n> quote\n> more\n\n- one\n  - two\n    - three\n- four\n\n1. x\n2. y\n\n- [ ] task\n- [x] done\n\n---\n\nend',
  'a\r\n\r\n- b\r\n- b\r\n\r\n# h\r\n\r\n> q\r\n',
  'same\nsame\n\nsame\n\n\n- same\n- same\n\n\n\n# same',
  'some **bold** and *it* and `code` ~~gone~~\n\n**x**\n- **item** one\n\n> *q*',
  '',
  '1) one\n\n\n2) two\n   more\n\n- [ ] a\n\n  - [x] b',
  '# é😀\n\n- 😀 **é**\n\n\n😀\r\n> é',
  '1. a\n10. **b**\n  - [ ] c\n> - d\n- \n9) e\n- [x] ',
  'p\n```js name:a.js\nlet a\n\n  b\n```\n```py\nc\n```\n```\n```\nq\n~~~Rust\nd\n~~~\n```\nopen',
  // One line short of a block whose gutter is three digits wide.
  `x\n\`\`\`sh\n${Array.from({ length: 99 }, (_, index) => `l${index}`).join('\n')}\n\`\`\`\ny`,
  'p\n| a | **b** |\n|:--|--:|\n| c | `d\\|e` |\n| f |\n| g | h | i |\nq\n| x |\n|---|',
  '| [l](u) #t | **b** |\n|---|---|\n| - x | `c` |',
  '| é | 😀 |\n| --- | :-: |\n|  | z\n\n| not | a table |\n> | quoted |\n> |---|',
];
const FIXED_SEEDS = Array.from({ length: 120 }, (_, index) => index + 1);
const OPERATIONS_PER_SEED = 120;
const CHARACTERS = [...'ab Z-#>19.)*`[] é😀|'];
/** Typed where the engine's caret is: right after a fence is typed, that writes its info string. */
const FENCE_TYPING = ['```', 'js', ' name:x.y', '\n', 'a', '~~~'];
const PASTES = [
  '- a\n- b',
  '\n\n# h\n',
  '1. x\n\n2) y',
  '> q\n\n',
  'plain\n\n\nlines',
  '**b**\n*i*',
  '```js\nx\n\ny\n```',
  '```\n```\n```py\nz\n```',
  'a\n```\nunclosed',
  '| p | q |\n|---|---|\n| r |',
  '|---|',
];
const KEYS: ParagraphKey[] = ['Enter', 'ShiftEnter', 'Backspace', 'Delete', 'Tab', 'ShiftTab'];
const COMMANDS: BlockCommand[] = [
  { Heading: 1 },
  { Heading: 3 },
  { Heading: 0 },
  'BulletList',
  'OrderedList',
  'TaskList',
  'Quote',
  'ToggleTask',
  'CodeBlock',
];
const FORMATS: InlineFormat[] = ['Bold', 'Italic', 'Strike', 'Code'];

beforeAll(loadEngineBuild);

function randomNumbers(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** An offset, most often a line's start or end, where line rebuilds go wrong. */
function pickOffset(model: LineModel, random: () => number): number {
  const line = model.lines[Math.floor(random() * model.lines.length)];
  const roll = random();
  if (roll < 0.4) return line.start;
  if (roll < 0.8) return line.start + line.text.length;
  const within = Math.floor(random() * (line.text.length + 1));
  // Never between the two halves of a surrogate pair, where the page puts no caret.
  const lowHalf = /[\uDC00-\uDFFF]/.test(line.text.charAt(within));
  return line.start + within - (lowHalf ? 1 : 0);
}

function pickSpan(model: LineModel, random: () => number): Span {
  const anchor = pickOffset(model, random);
  if (random() < 0.65) return [anchor, anchor];
  const focus = pickOffset(model, random);
  return [Math.min(anchor, focus), Math.max(anchor, focus)];
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

/** A list item's marker unit, the target of one input in five while the note has one. */
function pickMarker(model: LineModel, random: () => number): Span | null {
  const markers = model.lines.flatMap((line) =>
    line.atoms
      .filter((atom) => atom.kind === 'ListMarker')
      .map((atom): Span => [line.start + atom.start, line.start + atom.end]),
  );
  return markers.length > 0 ? markers[Math.floor(random() * markers.length)] : null;
}

/** An input aimed at a marker unit: typed over (a new marker, or text) or before, deleted
 *  from either side or as a selection, cut, or a selection from it into its text replaced. */
function markerOperation([start, end]: Span, random: () => number): Operation {
  const roll = random();
  if (roll < 0.25)
    return { type: 'type', at: [start, end], text: pick(['5. ', '- ', 'x', '- [ ] '], random) };
  if (roll < 0.4) return { type: 'key', at: [end, end], key: 'Backspace' };
  if (roll < 0.55) return { type: 'key', at: [start, start], key: 'Delete' };
  if (roll < 0.65)
    return { type: 'key', at: [start, end], key: pick(['Backspace', 'Delete', 'Enter'], random) };
  if (roll < 0.75)
    return { type: 'type', at: [start, start], text: pick(['q', '# ', '> '], random) };
  if (roll < 0.85) return { type: 'cut', at: [start, end] };
  if (roll < 0.95) return { type: 'type', at: [start, end + 1], text: 'z' };
  return { type: 'key', at: [start, start], key: pick(['Enter', 'Backspace'], random) };
}

function pickOperation(model: LineModel, random: () => number): Operation {
  const marker = random() < 0.2 ? pickMarker(model, random) : null;
  if (marker) return markerOperation(marker, random);
  const at = pickSpan(model, random);
  const roll = random();
  if (roll < 0.3) {
    const length = 1 + Math.floor(random() * 3);
    const text = Array.from({ length }, () => pick(CHARACTERS, random)).join('');
    return { type: 'type', at, text };
  }
  if (roll < 0.6) return { type: 'key', at, key: pick(KEYS, random) };
  if (roll < 0.7) return { type: 'block', at, command: pick(COMMANDS, random) };
  if (roll < 0.78) return { type: 'format', at, format: pick(FORMATS, random), text: 'f' };
  if (roll < 0.83) return { type: 'paste', at, text: pick(PASTES, random) };
  if (roll < 0.85) return { type: 'cut', at };
  if (roll < 0.87) return { type: 'move', at, to: pickOffset(model, random) };
  if (roll < 0.9) return { type: 'typeAtCaret', text: pick(FENCE_TYPING, random) };
  return random() < 0.7 ? { type: 'undo' } : { type: 'redo' };
}

/** Run `operation` as the page would: the selection handed to the engine, then the input. */
function runOperation(engine: Engine, model: LineModel, operation: Operation): Applied[] {
  if (operation.type === 'undo') return [engine.undo()].filter((applied) => !!applied);
  if (operation.type === 'redo') return [engine.redo()].filter((applied) => !!applied);
  if (operation.type === 'typeAtCaret') {
    const caret = engine.selection();
    const range = { start: model.toUtf16(caret.start), end: model.toUtf16(caret.end) };
    return [engine.replace(range, operation.text, 'Typing')].filter((applied) => !!applied);
  }
  const [start, end] = operation.at;
  const range = { start, end };
  const bytes = { start: model.toByte(start), end: model.toByte(end) };
  engine.placeSelection(bytes, 'Backward');
  const one = (applied: Applied | null): Applied[] => (applied ? [applied] : []);
  switch (operation.type) {
    case 'type':
      return one(engine.replace(range, operation.text, 'Typing'));
    case 'key':
      return one(engine.paragraphKey(range, operation.key));
    case 'block':
      return one(engine.blockCommand(range, operation.command));
    case 'format': {
      const toggled = engine.toggleFormat(operation.format);
      if (start !== end) return one(toggled);
      return one(engine.replace(range, operation.text, 'Typing'));
    }
    case 'paste':
      return one(engine.paste(bytes, operation.text));
    case 'cut':
      return one(engine.cut(bytes)[1]);
    case 'move':
      return engine.move(bytes, model.toByte(operation.to));
  }
}

function drawn(model: LineModel): HTMLElement[] {
  return model.lines.map((line) => {
    const element = document.createElement('div');
    drawLine(element, line);
    return element;
  });
}

/** A note open on the page: its engine, lines, line elements and the editor holding them. */
interface OpenNote {
  engine: Engine;
  model: LineModel;
  elements: HTMLElement[];
  editor: HTMLElement;
}

/** Why the page no longer shows the engine's reading, or null: its lines against a fresh read,
 *  its elements against a fresh draw, and each element's text against its line's, one atom
 *  element per atom (a draw wrong both ways is caught here). */
function drift({ engine, model, elements, editor }: OpenNote): string | null {
  const read = LineModel.from(engine.projectAll()).lines;
  if (!holds(editor, elements)) return 'the editor does not hold exactly the line elements';
  const found = lineModelDrift(model.lines, read) ?? drawnLineDrift(elements, model.lines);
  if (found) return found;
  for (const [index, line] of model.lines.entries()) {
    const element = elements[index];
    if (element.textContent !== line.text) return `line ${index + 1} holds other text`;
    // What a row does not draw is its pipes and the padding after its last one.
    const undrawn = [...element.querySelectorAll('.table-pipe')].map((part) => part.textContent);
    if (undrawn.some((text) => !/^\|[ \t]*$/.test(text ?? ''))) {
      return `line ${index + 1} hides ${JSON.stringify(undrawn)}`;
    }
    // An atom element holds its atom's text: one `\uFFFC`, or a wikilink's `[[target]]`.
    const texts = atomElementsOf(element).map((atomElement) => atomElement.textContent);
    const atomTexts = line.atoms.map((atom) => line.text.slice(atom.start, atom.end));
    if (texts.join('\0') !== atomTexts.join('\0')) {
      return `line ${index + 1} draws atoms ${JSON.stringify(texts)} for ${JSON.stringify(atomTexts)}`;
    }
  }
  return null;
}

interface Run {
  applied: number;
  failure: string | null;
}

/** What replays a failure: the seed, the note it opened and the inputs up to the failing one. */
interface Replay {
  seed: number;
  source: string;
  operations: Operation[];
}

function failureOf({ seed, source, operations }: Replay, found: string): string {
  const replay = JSON.stringify(operations);
  return `seed ${seed}, source ${JSON.stringify(source)}\noperations ${replay}\n${found}`;
}

async function openNote(source: string): Promise<OpenNote> {
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  const model = LineModel.from(engine.projectAll());
  const elements = drawn(model);
  const editor = document.createElement('div');
  editor.append(...chunked(elements));
  return { engine, model, elements, editor };
}

/** Show `applied` on `note` as the page does. */
function show(note: OpenNote, applied: readonly Applied[]): void {
  const { engine, model, elements } = note;
  const changes = applied.map((one) => one.change);
  applyViewChanges({ elements, model, changes, project: engine.project.bind(engine) });
}

async function runSeed(seed: number): Promise<Run> {
  const random = randomNumbers(seed);
  const source = SOURCES[seed % SOURCES.length];
  const note = await openNote(source);
  const { engine, model } = note;
  const operations: Operation[] = [];
  const replay: Replay = { seed, source, operations };
  let applied = 0;
  try {
    for (let step = 0; step < OPERATIONS_PER_SEED; step++) {
      const operation = pickOperation(model, random);
      operations.push(operation);
      let changes: Applied[];
      try {
        changes = runOperation(engine, model, operation);
      } catch (error) {
        // The engine refuses some inputs (a format inline code cannot hold); a trap is a bug.
        if (error instanceof WebAssembly.RuntimeError) {
          return { applied, failure: failureOf(replay, `engine trap: ${error}`) };
        }
        continue;
      }
      applied += changes.length;
      show(note, changes);
      const found = drift(note);
      if (found) return { applied, failure: failureOf(replay, found) };
    }
  } finally {
    engine.free();
  }
  return { applied, failure: null };
}

const MORE_SEEDS = Number(process.env.DESKTOP_EDITOR_DIFFERENTIAL_SEEDS ?? 0);
const SEEDS = [...FIXED_SEEDS, ...Array.from({ length: MORE_SEEDS }, (_, index) => 1000 + index)];

// The fixed seeds take about 1 s on an idle machine; extra ones about 10 ms each.
it(
  'draws exactly the engine reading of the note after every input',
  { timeout: 30_000 + MORE_SEEDS * 50 },
  async () => {
    const failures: string[] = [];
    let applied = 0;
    for (const seed of SEEDS) {
      const run = await runSeed(seed);
      applied += run.applied;
      if (run.failure) failures.push(run.failure);
    }
    expect(failures.join('\n\n')).toBe('');
    // The inputs must mostly reach the engine, or the test proves little.
    expect(applied).toBeGreaterThan(SEEDS.length * OPERATIONS_PER_SEED * 0.5);
  },
);

it("widens every line of a code block's gutter when its line count reaches 100", async () => {
  const code = Array.from({ length: 99 }, (_, index) => `line ${index}`).join('\n');
  const note = await openNote(`x\n\`\`\`\n${code}\n\`\`\`\ny`);
  const { engine, model } = note;
  try {
    expect(model.lines[1].code?.digits).toBe(2);
    const middle = model.lines[50];
    const end = middle.start + middle.text.length;
    show(note, [engine.paragraphKey({ start: end, end }, 'Enter')!]);
    expect(drift(note)).toBeNull();
    expect(new Set(model.lines.slice(1, 101).map((line) => line.code?.digits))).toEqual(
      new Set([3]),
    );
  } finally {
    engine.free();
  }
});

/* An edit that ends one block and starts another, or joins two, changes where a block starts
 * for a line the edit did not read again; the change's projection describes that line too. */
it('describes the line a Code block command makes the first of a new block', async () => {
  const note = await openNote('a\n```\nx\ny\nz\n```\nb');
  const { engine, model } = note;
  try {
    const at = model.lines[2].start;
    show(note, [engine.blockCommand({ start: at, end: at }, 'CodeBlock')!]);
    expect(drift(note)).toBeNull();
  } finally {
    engine.free();
  }
});

it('describes the first line of a block a paste joins to the block above', async () => {
  // The pasted closing fence takes the `q` after it, so it opens nothing and closes nothing:
  // the pasted block runs on through the next one, whose `fz` is no longer a first line.
  const note = await openNote('a\n```\nkq\n```\n```py\nfz\n```');
  const { engine, model } = note;
  try {
    show(note, [engine.paste({ start: 0, end: model.toByte(3) }, '```py\nz\n```')!]);
    expect(drift(note)).toBeNull();
  } finally {
    engine.free();
  }
});

/** Undo `steps` times on `note`, each shown and compared with a fresh read. */
function undone(note: OpenNote, steps: number): void {
  for (let step = 0; step < steps; step++) {
    const applied = note.engine.undo();
    if (applied) show(note, [applied]);
    expect(drift(note)).toBeNull();
  }
}

// `fitBlockNeighbours`
it('marks two blocks touching once the line between them goes, and apart after Undo', async () => {
  const note = await openNote('x\n```\na\n```\nmid\n```\nb\n```\ny');
  const { engine, model } = note;
  const touching = () => [model.lines[1].code?.overBlock, model.lines.at(-2)?.code?.underBlock];
  try {
    const mid = model.lines[2].byteStart;
    show(note, [engine.replace({ start: mid, end: mid + 3 }, '', 'Typing')!]);
    show(note, [engine.paragraphKey({ start: mid, end: mid }, 'Backspace')!]);
    expect(drift(note)).toBeNull();
    expect(touching()).toEqual([true, true]);
    undone(note, 2);
    expect(touching()).toEqual([false, false]);
  } finally {
    engine.free();
  }
});

it('keeps the touching blocks right as a fence is typed under a block, and after Undo', async () => {
  const note = await openNote('x\n```\na\n```\nmid\ny');
  try {
    for (let typed = 0; typed < 3; typed++) {
      const at = note.model.lines[2].byteStart;
      show(note, [note.engine.replace({ start: at, end: at }, '`', 'Typing')!]);
      expect(drift(note)).toBeNull();
    }
    undone(note, 3);
  } finally {
    note.engine.free();
  }
});

/** The roles and column counts the page holds for `note`'s lines, a line outside a table null. */
const tableShapes = ({ model }: OpenNote): Array<string | null> =>
  model.lines.map((line) => {
    const table = line.table;
    if (!table) return null;
    return table.role === 'delimiter' ? 'delimiter' : `${table.role} ${table.columns}`;
  });

/** Type `text` over UTF-16 `from`..`to` of `note` as the page does, then compare it with a
 *  fresh read. */
function typed(note: OpenNote, from: number, to: number, text: string): void {
  show(note, [note.engine.replace({ start: from, end: to }, text, 'Typing')!]);
  expect(drift(note)).toBeNull();
}

/* What a change's projection leaves to the table entry: the column count and alignments of rows
 * it did not describe again (portable-core/tables.md). */
it('makes the lines under a header a table when its delimiter row is typed', async () => {
  const note = await openNote('| a | b |\n| c | d |\n| e |\nend');
  try {
    expect(tableShapes(note)).toEqual([null, null, null, null]);
    typed(note, note.model.lines[1].start, note.model.lines[1].start, '|---|---|\n');
    expect(tableShapes(note)).toEqual(['header 2', 'delimiter', 'row 2', 'row 2', null]);
  } finally {
    note.engine.free();
  }
});

it('gives every row the new column count when a body row is made wider than the header', async () => {
  const note = await openNote('| a | b |\n|---|---|\n| c | d |\n| e | f |\n| g | h |');
  try {
    const row = note.model.lines[3];
    const at = row.start + row.text.indexOf('f') + 1;
    typed(note, at, at, ' | x | y');
    expect(tableShapes(note)).toEqual(['header 4', 'delimiter', 'row 4', 'row 4', 'row 4']);
  } finally {
    note.engine.free();
  }
});

it("gives every row the new alignment when the delimiter row's is changed", async () => {
  const note = await openNote('| a | b |\n|---|---|\n| c | d |\n| e | f |');
  try {
    const delimiter = note.model.lines[1];
    const at = delimiter.start + 4;
    typed(note, at, at, ':');
    const alignments = note.model.lines.map((line) =>
      line.table && line.table.role !== 'delimiter' ? line.table.alignments.join() : null,
    );
    expect(alignments).toEqual(['Right,None', null, 'Right,None', 'Right,None']);
  } finally {
    note.engine.free();
  }
});

it('makes the rows under a broken table line text', async () => {
  const note = await openNote('| a | b |\n|---|---|\n| c | d |\n| e | f |\n| g | h |');
  try {
    const row = note.model.lines[2];
    const at = row.start + row.text.indexOf('c') + 1;
    typed(note, at, at, '\n');
    expect(tableShapes(note)).toEqual(['header 2', 'delimiter', 'row 2', null, null, null]);
  } finally {
    note.engine.free();
  }
});

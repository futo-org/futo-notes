/* Syntax colours for the note's fenced code blocks (docs/spec/editor/desktop/code-colours.md),
 * drawn as spans in the code lines as format runs are (`Line.colours`, lineSegments.ts). Typing
 * parses nothing: an edit's lines keep the colours of the lines they replaced (carryColours.ts)
 * and are remembered; after the next paint each block holding one is parsed again where it
 * changed and its lines coloured, the ones on screen first, in slices of a few milliseconds, and
 * only the lines whose colours differ are drawn again. A block draws uncoloured until its grammar
 * arrives (codeGrammars.ts, loaded with the first block that names a language). */
import type { Parser } from '@lezer/common';
import type { BlockParse, ParsedBlock } from './codeGrammars';
import { drawLine, drawnLineOf } from './lineElements';
import { carryColours } from './carryColours';
import { codeBlockAround, codeBlockText, codeLineAtOffset } from './codeBlockText';
import { firstBelow } from './highlight';
import { NO_COLOURS, type ColourRun, type Line, type LineSplice } from './lineModel';
import type { EditorView } from './view';

type CodeGrammars = typeof import('./codeGrammars');

/** A block longer than this stays uncoloured: colouring it again after an edit would take
 *  more than a few frames of background work. */
const MAX_COLOURED_CHARACTERS = 200_000;
/** How long one background task colours before it yields, ms. */
const SLICE_MILLISECONDS = 5;
/** How many lines are coloured between two looks at the clock. */
const LINES_PER_STEP = 100;
/** How long a pass waits for a frame before it runs anyway (a window in the background). */
const FRAME_WAIT_MILLISECONDS = 100;

/** A block's parse, kept across edits by its first line's element (reused by an edit there). */
interface BlockColours {
  parsed: ParsedBlock | null;
  parsing: BlockParse | null;
}

/** A block to colour again: from its line `from` on, the lines left (`ranges`, in the block,
 *  the ones on screen first) once it is parsed. */
interface BlockJob {
  first: Line;
  from: number;
  ranges: Array<[number, number]> | null;
}

export class EditorCodeColours {
  private grammars: CodeGrammars | null = null;
  private grammarsLoading: Promise<void> | null = null;
  private readonly touched = new Set<Line>();
  private readonly jobs = new Map<Line, BlockJob>();
  private readonly waiting = new Set<Promise<void>>();
  private blocks = new WeakMap<HTMLElement, BlockColours>();
  private scheduled = false;
  private destroyed = false;

  constructor(private readonly view: EditorView) {}

  /** A note opened: colour all its blocks. */
  open(): void {
    this.jobs.clear();
    this.touched.clear();
    this.blocks = new WeakMap();
    this.touchEveryBlock();
  }

  /** An edit's lines, as `applyViewChanges` splices them in (before they are drawn): they keep
   *  the colours of the lines they replaced, and their blocks are coloured again after the
   *  next paint. */
  readonly spliced = (splice: LineSplice): void => {
    const lines = this.view.displayLines();
    const replaced = this.view
      .lineElements()
      .slice(splice.first, splice.first + splice.removed)
      .map(drawnLineOf)
      .filter((line) => line !== undefined);
    carryColours(lines, splice, replaced);
    const end = Math.max(splice.first + splice.added, splice.restyled[1]);
    for (let index = Math.min(splice.first, splice.restyled[0]); index < end; index++) {
      this.touched.add(lines[index]);
    }
    this.schedule();
  };

  /** Colouring is still to be done (an edit's, or a grammar on its way). */
  pending(): boolean {
    return this.touched.size > 0 || this.jobs.size > 0 || this.waiting.size > 0;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Colour until `deadline` (`performance.now()`), then go on after the next paint. */
  colourNow(deadline = Infinity): void {
    if (this.destroyed) return;
    if (this.view.isComposing()) return this.schedule();
    this.plan();
    const ends = this.view.selection.ends();
    let redrew = false;
    for (const [first, job] of this.jobs) {
      if (performance.now() >= deadline) break;
      const step = this.step(job, deadline);
      redrew ||= step.redrew;
      if (step.done) this.jobs.delete(first);
    }
    // A line drawn again may have held the selection's DOM point.
    if (redrew && document.activeElement === this.view.dom) {
      this.view.selection.showEngineSelection(!!ends && ends.focus < ends.anchor);
    }
    if (this.jobs.size > 0 || this.touched.size > 0) this.schedule();
  }

  /** After the next paint, or a moment later when no frame comes. */
  private schedule(): void {
    if (this.scheduled || this.destroyed) return;
    this.scheduled = true;
    let ran = false;
    const run = () => {
      if (ran) return;
      ran = true;
      this.scheduled = false;
      this.colourNow(performance.now() + SLICE_MILLISECONDS);
    };
    requestAnimationFrame(() => setTimeout(run, 0));
    setTimeout(run, FRAME_WAIT_MILLISECONDS);
  }

  private touchEveryBlock(): void {
    for (const line of this.view.displayLines()) if (line.code?.first) this.touched.add(line);
    if (this.touched.size > 0) this.schedule();
  }

  /** A job for each block holding a line touched since the last pass, from its first touched
   *  line (or a job's unfinished lines); a line no longer in a block loses its colours. */
  private plan(): void {
    const model = this.view.lineModel();
    if (!model || this.touched.size === 0) return;
    const lines = model.lines;
    const indices: number[] = [];
    for (const line of this.touched) {
      const index = model.lineAt(line.start);
      if (lines[index] === line) indices.push(index);
    }
    this.touched.clear();
    indices.sort((first, second) => first - second);
    let job: BlockJob | null = null;
    let blockStart = 0;
    let blockEnd = -1;
    for (const index of indices) {
      const line = lines[index];
      if (!line.code) {
        line.colours = NO_COLOURS;
        continue;
      }
      if (job && index < blockEnd) {
        job.from = Math.min(job.from, index - blockStart);
        continue;
      }
      [blockStart, blockEnd] = codeBlockAround(lines, index);
      const first = lines[blockStart];
      const earlier = this.jobs.get(first);
      job = { first, from: Math.min(index - blockStart, unfinishedFrom(earlier)), ranges: null };
      this.jobs.set(first, job);
    }
  }

  /** Work on `job` until `deadline`: parse its block, then colour its lines. */
  private step(job: BlockJob, deadline: number): { done: boolean; redrew: boolean } {
    const model = this.view.lineModel();
    const start = model ? model.lineAt(job.first.start) : -1;
    if (!model || model.lines[start] !== job.first || !job.first.code?.first) {
      return { done: true, redrew: false };
    }
    const lines = model.lines;
    const { text, lineStarts } = codeBlockText(lines, start, codeBlockAround(lines, start)[1]);
    const language = job.first.code.language;
    const parser =
      language && text.length <= MAX_COLOURED_CHARACTERS ? this.parserOf(language) : null;
    if (parser === 'waiting') return { done: true, redrew: false };
    const block = this.blockColoursOf(this.view.lineElements()[start]);
    const grammars = this.grammars;
    if (!parser || !grammars) {
      block.parsed = block.parsing = null;
      return { done: true, redrew: this.drawColours(start, lineStarts.length, () => NO_COLOURS) };
    }
    const parsed = this.parsedBlock({ job, block, grammars, parser, text, lineStarts, deadline });
    if (!parsed) return { done: false, redrew: false };
    job.ranges ??= rangesOnScreenFirst(job.from, lineStarts.length, this.linesOnScreen(start));
    let redrew = false;
    while (job.ranges.length > 0 && performance.now() < deadline) {
      const range = job.ranges[0];
      const to = Math.min(range[1], range[0] + LINES_PER_STEP);
      const colours = grammars.blockLineColours(parsed, lineStarts, range[0], to);
      const drawn = this.drawColours(start + range[0], to - range[0], (index) => colours[index]);
      redrew ||= drawn;
      range[0] = to;
      if (range[0] >= range[1]) job.ranges.shift();
    }
    return { done: job.ranges.length === 0, redrew };
  }

  /** `block` parsed as `text` under `parser`, parsing it again where it changed until
   *  `deadline`; null while that parse goes on. The job then colours from the first line it
   *  changed, if not from earlier. */
  private parsedBlock({
    job,
    block,
    grammars,
    parser,
    text,
    lineStarts,
    deadline,
  }: {
    job: BlockJob;
    block: BlockColours;
    grammars: CodeGrammars;
    parser: Parser;
    text: string;
    lineStarts: readonly number[];
    deadline: number;
  }): ParsedBlock | null {
    const parsed = block.parsed;
    if (parsed?.parser === parser && parsed.text === text) return parsed;
    if (block.parsing?.parser !== parser || block.parsing.text !== text) {
      block.parsing = grammars.startBlockParse(parser, text, parsed);
      job.from = Math.min(job.from, codeLineAtOffset(lineStarts, block.parsing.changedFrom));
      job.ranges = null;
    }
    block.parsed = grammars.advanceBlockParse(block.parsing, deadline);
    if (block.parsed) block.parsing = null;
    return block.parsed;
  }

  /** Give `count` lines from `start` the colours `coloursAt` has for each (by its place from
   *  `start`), drawing those that change; whether any did. */
  private drawColours(
    start: number,
    count: number,
    coloursAt: (index: number) => readonly ColourRun[],
  ): boolean {
    const lines = this.view.displayLines();
    const elements = this.view.lineElements();
    let redrew = false;
    for (let index = start; index < start + count; index++) {
      const colours = coloursAt(index - start);
      const line = lines[index];
      if (sameColours(line.colours, colours)) continue;
      line.colours = colours.length > 0 ? colours : NO_COLOURS;
      drawLine(elements[index], line);
      redrew = true;
    }
    return redrew;
  }

  private blockColoursOf(firstElement: HTMLElement): BlockColours {
    let block = this.blocks.get(firstElement);
    if (!block) {
      block = { parsed: null, parsing: null };
      this.blocks.set(firstElement, block);
    }
    return block;
  }

  /** The parser for `language`, null for none, or `waiting` while it (or the grammars) load:
   *  its blocks are coloured again once they have. */
  private parserOf(language: string): Parser | null | 'waiting' {
    if (!this.grammars) {
      if (this.grammarsLoading && !this.waiting.has(this.grammarsLoading)) return null;
      this.grammarsLoading ??= import('./codeGrammars').then((grammars) => {
        this.grammars = grammars;
      });
      this.wait(this.grammarsLoading);
      return 'waiting';
    }
    const parser = this.grammars.grammarParser(language);
    if (!(parser instanceof Promise)) return parser;
    this.wait(parser);
    return 'waiting';
  }

  private wait(loading: Promise<void>): void {
    if (this.waiting.has(loading)) return;
    this.waiting.add(loading);
    const settled = () => {
      this.waiting.delete(loading);
      if (!this.destroyed) this.touchEveryBlock();
    };
    loading.then(settled, settled);
  }

  /** The block lines from `start` on that are on screen, in the block's numbering. */
  private linesOnScreen(start: number): [number, number] {
    const elements = this.view.lineElements();
    const from = firstBelow(elements, 0);
    const to = Math.max(from, firstBelow(elements, window.innerHeight) + 1);
    return [from - start, to - start];
  }
}

/** The first line a job had left to colour; Infinity for none. */
function unfinishedFrom(job: BlockJob | undefined): number {
  if (!job) return Infinity;
  if (!job.ranges) return job.from;
  return Math.min(Infinity, ...job.ranges.map((range) => range[0]));
}

/** Lines `from` to `count` in order to colour: those of `screen` first, then the rest. */
function rangesOnScreenFirst(
  from: number,
  count: number,
  [screenFrom, screenTo]: [number, number],
): Array<[number, number]> {
  const visibleFrom = Math.min(Math.max(from, screenFrom), count);
  const visibleTo = Math.min(Math.max(visibleFrom, screenTo), count);
  const ranges: Array<[number, number]> = [
    [visibleFrom, visibleTo],
    [from, visibleFrom],
    [visibleTo, count],
  ];
  return ranges.filter(([rangeFrom, rangeTo]) => rangeTo > rangeFrom);
}

function sameColours(first: readonly ColourRun[], second: readonly ColourRun[]): boolean {
  if (first.length !== second.length) return false;
  return first.every(
    (run, index) =>
      run.start === second[index].start &&
      run.end === second[index].end &&
      run.className === second[index].className,
  );
}

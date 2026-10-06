/**
 * Which sites a block really needs, decided by parsing.
 *
 * A block is written with every site in its house-style spelling first. If
 * that reads back as the block, it is the answer — the common case, one parse.
 * Otherwise the block's inline units (paragraphs, headings, cells) whose
 * reading came out different are settled one by one, each against a parse of
 * that unit alone, and the block is parsed once more to confirm — so a big
 * list or table costs parses of the cells that need an escape, not of the
 * whole table again and again. Only if that does not hold does the whole block
 * go through the slow path: every ESCAPE site takes its safe spelling (a backslash, a character
 * reference, `***`, a link in full); if the block still reads differently, its
 * LAYOUT sites (a blank line the house style would leave out, a lazy line) are
 * tried one at a time in document order, each kept when it makes the reading
 * agree with the block further into the document. Then the escapes are taken
 * back again, a halving group at a time with the right side first, keeping
 * each removal the parse does not notice. Right first is what puts a needed
 * escape on an OPENING delimiter (`\*not italic*`). Every order and group size
 * depends only on the block, so every device makes the same choices.
 *
 * Some documents have no spelling that reads back exactly — text the parser
 * would turn into a link whatever is escaped, say. Then the target is what the
 * safest spelling reads as, and the removals keep exactly that reading: the
 * document still loses nothing more than it must, and the output carries no
 * backslash that changes nothing.
 */
import { render, type InlineUnit, type Line, type SiteScope } from './pieces';

export interface Written {
  readonly lines: readonly Line[];
  readonly siteCount: number;
  /** The layout sites, in writing order; every other site is an escape. */
  readonly layout: readonly number[];
  readonly units: readonly InlineUnit[];
}

/** Markdown in, a comparable reading out (`./normalize.ts` `canonical`), or null when it did not parse. */
export type Reader = (markdown: string) => string | null;

/**
 * How much parsing one phase of one block may spend taking escapes back. Past
 * it the remaining escapes stay — correct, just not minimal. The limits are a
 * count and a size, never a clock, so they fall at the same place on every
 * device.
 */
export interface CheckBudget {
  readonly checks: number;
  /** Characters of markdown parsed. */
  readonly characters: number;
}

export const DEFAULT_CHECK_BUDGET: CheckBudget = { checks: 400, characters: 2_000_000 };

/** The unit phase's own budget: its parses are of one paragraph line or one cell. */
const UNIT_BUDGET: CheckBudget = { checks: 20_000, characters: 2_000_000 };

class Spending {
  private checks = 0;
  private characters = 0;
  constructor(private readonly budget: CheckBudget) {}
  /** Records a parse of `length` characters; false once the budget is spent. */
  spend(length: number): boolean {
    if (this.checks >= this.budget.checks || this.characters >= this.budget.characters) {
      return false;
    }
    this.checks += 1;
    this.characters += length;
    return true;
  }
}

/** `plausible` is the block as `write('plausible')` writes it (the caller has it already). */
export function chooseSpelling(
  plausible: Written,
  write: (scope: SiteScope) => Written,
  read: Reader,
  expected: string,
  budget: CheckBudget = DEFAULT_CHECK_BUDGET,
): string {
  const plain = render(plausible.lines);
  const plainReading = read(plain);
  if (plainReading === expected) return plain;

  const byUnit = settleUnits(plausible, read, expected, plainReading, new Spending(UNIT_BUDGET));
  if (byUnit) {
    const text = render(plausible.lines, byUnit);
    if (read(text) === expected) return text;
  }

  const lines = plausible.lines;
  const fallback = settleLayout(plausible, read, expected);
  if (fallback.reading === expected) {
    const choice = takeBack(lines, escapesOf(plausible), fallback.choice, read, expected, budget);
    return render(lines, choice);
  }
  const every = write('every');
  const broad = settleLayout(every, read, expected);
  if (broad.reading === expected) {
    const choice = takeBack(every.lines, escapesOf(every), broad.choice, read, expected, budget);
    return render(every.lines, choice);
  }
  // Nothing reads back exactly: keep what the safest spelling reads as.
  const target = fallback.reading;
  return render(
    lines,
    takeBack(lines, escapesOf(plausible), fallback.choice, read, target, budget),
  );
}

/** The escape sites of `written`, right to left. */
function escapesOf(written: Written, first = 0, end = written.siteCount): number[] {
  const layout = new Set(written.layout);
  const sites: number[] = [];
  for (let site = end - 1; site >= first; site -= 1) if (!layout.has(site)) sites.push(site);
  return sites;
}

/**
 * The inline content of a reading, in document order: every paragraph and
 * heading, plus a table cell's paragraph even when it is empty — one entry per
 * paragraph, heading or cell the writer writes (`InlineUnit.leaf`; an empty
 * paragraph outside a cell is not written). A paragraph outside a cell is
 * split at each line break that carries no mark, as the writer splits it into
 * units (`InlineUnit.segment`).
 */
function leaves(reading: string): string[][] {
  type Canon = { type: string; marks?: unknown; content?: Canon[] };
  const out: string[][] = [];
  const segments = (content: readonly Canon[]): string[] => {
    const runs: Canon[][] = [[]];
    for (const node of content) {
      if (node.type === 'hardbreak' && !node.marks) runs.push([]);
      else (runs[runs.length - 1] as Canon[]).push(node);
    }
    return runs.map((run) => JSON.stringify(run));
  };
  const walk = (node: Canon, inCell: boolean): void => {
    if (node.type === 'heading' || inCell) {
      out.push([JSON.stringify(node)]);
      return;
    }
    if (node.type === 'paragraph') {
      if (node.content) out.push(segments(node.content));
      return;
    }
    const cell = node.type === 'table_header' || node.type === 'table_cell';
    for (const child of node.content ?? []) walk(child, cell);
  };
  for (const node of JSON.parse(reading) as Canon[]) walk(node, false);
  return out;
}

/**
 * Each unit that reads wrong in the plain spelling (all of them with escape
 * sites, when the block's shape broke and the readings cannot be lined up),
 * settled against a parse of the unit alone: its target is what the unit reads
 * as with every escape safe. Null when the block is a single unit.
 */
function settleUnits(
  written: Written,
  read: Reader,
  expected: string,
  plainReading: string | null,
  spending: Spending,
): number[] | null {
  const units = written.units;
  if (units.length < 2) return null;
  const want = leaves(expected);
  const got = plainReading === null ? null : leaves(plainReading);
  const reads = (unit: InlineUnit): string | undefined =>
    got && got.length === want.length && got[unit.leaf]?.length === want[unit.leaf]?.length
      ? got[unit.leaf]?.[unit.segment]
      : undefined;
  const choice = new Array<number>(written.siteCount).fill(0);
  units.forEach((unit) => {
    const sites = escapesOf(written, unit.first, unit.end);
    if (sites.length === 0) return;
    // A unit that already reads right in the plain spelling keeps it.
    if (reads(unit) === want[unit.leaf]?.[unit.segment]) return;
    const readUnit: Reader = (text) =>
      spending.spend(text.length) ? read(unit.standalone(text)) : null;
    const plainUnit = readUnit(render(unit.lines, choice));
    for (const site of sites) choice[site] = 1;
    const target = readUnit(render(unit.lines, choice));
    if (target === null || plainUnit === target) {
      for (const site of sites) choice[site] = 0;
      return;
    }
    const settled = takeBack(unit.lines, sites, choice, readUnit, target, spending);
    for (const site of sites) choice[site] = settled[site] ?? 1;
  });
  return choice;
}

/** Escape sites safe, layout sites in the house style. */
function safeEscapes(written: Written): number[] {
  const choice = new Array<number>(written.siteCount).fill(1);
  for (const site of written.layout) choice[site] = 0;
  return choice;
}

function sharedPrefix(a: string | null, b: string): number {
  if (a === null) return -1;
  let index = 0;
  while (index < a.length && index < b.length && a.charCodeAt(index) === b.charCodeAt(index)) {
    index += 1;
  }
  return index;
}

/**
 * Escapes safe; then each layout site flipped in turn, kept when the reading
 * agrees with `expected` further into the document than before.
 */
function settleLayout(
  written: Written,
  read: Reader,
  expected: string,
): { choice: number[]; reading: string | null } {
  const choice = safeEscapes(written);
  let reading = read(render(written.lines, choice));
  let agreed = sharedPrefix(reading, expected);
  for (const site of written.layout) {
    if (reading === expected) break;
    choice[site] = 1;
    const flipped = read(render(written.lines, choice));
    const flippedAgreed = sharedPrefix(flipped, expected);
    if (flippedAgreed > agreed) {
      reading = flipped;
      agreed = flippedAgreed;
    } else {
      choice[site] = 0;
    }
  }
  return { choice, reading };
}

/**
 * From `start`, returns as many of `escapes` (right to left) as possible to the
 * house style, keeping each change whose reading is still `target`. A run of
 * sites is first tried all at once; if that changes the reading it is halved
 * and the RIGHT half is settled before the left, so of two escapes that would
 * each do, the left (opening) one is the one kept.
 */
function takeBack(
  lines: readonly Line[],
  escapes: readonly number[],
  start: readonly number[],
  read: Reader,
  target: string | null,
  budget: CheckBudget | Spending,
): number[] {
  const spending = budget instanceof Spending ? budget : new Spending(budget);
  const choice = [...start];
  const tries = (sites: readonly number[]): boolean => {
    for (const site of sites) choice[site] = 0;
    const text = render(lines, choice);
    if (spending.spend(text.length) && read(text) === target) return true;
    for (const site of sites) choice[site] = 1;
    return false;
  };
  const shrink = (sites: readonly number[]): void => {
    if (sites.length === 0 || tries(sites) || sites.length === 1) return;
    const half = Math.ceil(sites.length / 2);
    shrink(sites.slice(0, half));
    shrink(sites.slice(half));
  };
  shrink(escapes.filter((site) => choice[site] === 1));
  return choice;
}

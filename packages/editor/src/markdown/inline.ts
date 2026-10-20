/**
 * Inline content (a paragraph's, a heading's, a table cell's) as pieces.
 *
 * Two passes. The first turns ProseMirror's flat runs of marked text into a
 * token stream with explicit delimiters: a mark that spans several runs is
 * opened once, marks are nested so the one that runs longest is outermost, and
 * a link whose text is its own URL becomes one token that can be written bare.
 * The second turns text into pieces, offering an escape SITE wherever the
 * character could plausibly be read as syntax (`./pieces.ts`): the parse in
 * `./choose.ts` decides which of them really need it.
 *
 * Fixed, not decided by a parse (docs/spec/editor.md "Markdown house style"):
 * a code span's fence is one backtick longer than the longest run inside it.
 * (A paragraph never reaches here with an empty line in it, or with whitespace
 * at a line's start outside a link or code span: `./normalize.ts` splits it at
 * the one and drops the other.)
 */
import { MARK, type NodeJson } from './docJson';
import { type InlineKind } from './normalize';
import { splitLines, type Line, type Piece, type SitePiece, type Sites } from './pieces';
import {
  type Token,
  reference,
  isAsciiPunctuation,
  REFERENCE_TAIL,
  TokenWriter,
} from './inlineTokens';

/**
 * An emphasis or strong run whose opener directly follows another closer of
 * the same character would merge with it (`**a *b***` then `*c*` is
 * `****`), so its marker becomes a site: `*` unless the parse needs `_`.
 */
function touchingMarkers(tokens: Token[], sites: Sites): Token[] {
  const swaps = new Map<number, (options: readonly [string, string]) => SitePiece>();
  tokens.forEach((token, index) => {
    const before = tokens[index - 1];
    if (token.kind !== 'open' || before?.kind !== 'close') return;
    if (token.type !== MARK.emphasis && token.type !== MARK.strong) return;
    if (!before.delim.endsWith('*')) return;
    swaps.set(token.pair, sites.shared());
  });
  if (swaps.size === 0) return tokens;
  return tokens.map((token) => {
    if ((token.kind !== 'open' && token.kind !== 'close') || !swaps.has(token.pair)) return token;
    const site = swaps.get(token.pair) as (options: readonly [string, string]) => SitePiece;
    return { kind: 'site', piece: site([token.delim, token.delim.replace(/\*/g, '_')]) };
  });
}

/** The characters that can start or end markdown syntax wherever they stand. */
const ALWAYS = new Set(['\\', '`', '*', '~', '[', ']', '<', '|']);

/** The characters that can start syntax only as a line's first character. */
const LINE_START = new Set(['-', '+', '=', '>', '#']);

const isWord = (character: string | undefined): boolean =>
  character !== undefined && /^[\p{L}\p{N}]$/u.test(character);
const isSpaceOrEdge = (character: string | undefined): boolean =>
  character === undefined || /^\s$/.test(character);

interface TextContext {
  readonly lineStart: boolean;
  readonly afterDelimiter: boolean;
  readonly beforeDelimiter: boolean;
  readonly nextCharacter: string | undefined;
}

/** Whether `characters[index]` gets an escape site (see `ALWAYS`, `LINE_START`). */
function plausible(
  characters: readonly string[],
  index: number,
  context: TextContext & { kind: InlineKind; every: boolean },
): boolean {
  const character = characters[index] as string;
  if (!isAsciiPunctuation(character)) return false;
  if (context.every || ALWAYS.has(character)) return true;
  const atLineStart = context.lineStart && index === 0;
  if (atLineStart && LINE_START.has(character)) return true;
  if (character === '#' && context.kind === 'heading') return true;
  if (character === '_') return !(isWord(characters[index - 1]) && isWord(characters[index + 1]));
  if (character === '!') return (characters[index + 1] ?? context.nextCharacter) === '[';
  if (character === '&') {
    // At the end of a run, the rest of the reference would be in the next one.
    const rest = characters.slice(index + 1, index + 40).join('');
    return index === characters.length - 1 || REFERENCE_TAIL.test(rest);
  }
  if ((character === '.' || character === ')') && context.lineStart) {
    return /^\d{1,9}$/.test(characters.slice(0, index).join(''));
  }
  return false;
}

function textPieces(
  value: string,
  context: TextContext & { kind: InlineKind },
  sites: Sites,
): Piece[] {
  const characters = Array.from(value);
  const pieces: Piece[] = [];
  let fixed = '';
  const every = sites.scope === 'every';
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] as string;
    const edge =
      (index === 0 && context.afterDelimiter) ||
      (index === characters.length - 1 && context.beforeDelimiter);
    const escapable = plausible(characters, index, { ...context, every });
    if (!edge && !escapable) {
      fixed += character;
      continue;
    }
    if (fixed) pieces.push(fixed);
    fixed = '';
    const safe = isAsciiPunctuation(character) ? `\\${character}` : reference(character);
    pieces.push(sites.piece([character, safe]));
  }
  if (fixed) pieces.push(fixed);
  return pieces;
}

const isDelimiter = (token: Token | undefined): boolean =>
  token !== undefined &&
  ((token.kind === 'open' || token.kind === 'close') && token.type !== MARK.link
    ? true
    : token.kind === 'site' && /^[*_~]+$/.test(token.piece.options[0]));

/** What `token` writes in the house style. */
function spelling(token: Token | undefined): string {
  if (!token) return '';
  if (token.kind === 'site') return token.piece.options[0];
  return 'delim' in token ? token.delim : token.value;
}

const firstCharacter = (token: Token | undefined): string | undefined =>
  spelling(token).charAt(0) || undefined;
const lastCharacter = (token: Token | undefined): string | undefined =>
  spelling(token).slice(-1) || undefined;

/**
 * Whether an emphasis, strong or strikethrough delimiter at `index` opens or
 * closes where it stands beyond any doubt — a space or the edge outside, a
 * letter or digit inside (closing may also be followed by plain punctuation).
 * Only then is the block's parse check skipped for it; the check decides
 * every other case. Links and code spans are spelled the same in any context.
 */
function obviouslyFlanks(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index] as Token;
  if (token.kind !== 'open' && token.kind !== 'close') return false;
  if (token.type === MARK.link) return true;
  const before = lastCharacter(tokens[index - 1]);
  const after = firstCharacter(tokens[index + 1]);
  if (token.kind === 'open') return isSpaceOrEdge(before) && isWord(after);
  return isWord(before) && (isSpaceOrEdge(after) || /^[.,;:!?)'"]$/.test(after ?? ''));
}

/** How a unit of each kind parses on its own (see `InlineUnit`). */
const STANDALONE: Record<InlineKind, (text: string) => string> = {
  paragraph: (text) => text,
  heading: (text) => text,
  cell: (text) => `| ${text} |\n| --- |`,
};

/**
 * Inline content as lines of pieces, recorded in `sites` as units: one per
 * heading or cell, and one per run of a paragraph's lines between line breaks
 * that no formatting spans. A heading's caller passes its `# ` as `prefix`, so
 * the unit parses as a heading.
 */
export function writeInline(
  content: readonly NodeJson[],
  kind: InlineKind,
  sites: Sites,
  prefix = '',
): Line[] {
  const leaf = sites.leaves++;
  const first = sites.count;
  const { lines, boundaries } = writeUnit(content, kind, sites);
  const base = STANDALONE[kind];
  const standalone = prefix ? (text: string) => base(prefix + text) : base;
  let startLine = 0;
  let startSite = first;
  const ends = [...boundaries, { line: lines.length, site: sites.count }];
  ends.forEach((boundary, segment) => {
    const unitLines = lines.slice(startLine, boundary.line);
    // A run of lines inside a paragraph has a line before or after it: a
    // stand-in line keeps a trailing `\` a hard break, a `---` an underline.
    const before = segment > 0 ? 'x\n' : '';
    const after = segment < ends.length - 1 ? '\nx' : '';
    sites.units.push({
      lines: unitLines,
      first: startSite,
      end: boundary.site,
      leaf,
      segment,
      standalone: before || after ? (text) => standalone(before + text + after) : standalone,
    });
    startLine = boundary.line;
    startSite = boundary.site;
  });
  return lines;
}

/** The indexes of the line breaks no mark is open across. */
function cleanBreaks(tokens: readonly Token[]): Set<number> {
  const clean = new Set<number>();
  let open = 0;
  tokens.forEach((token, index) => {
    if (token.kind === 'open') open += 1;
    else if (token.kind === 'close') open -= 1;
    else if (token.kind === 'break' && open === 0) clean.add(index);
  });
  return clean;
}

const countNewlines = (text: string): number => text.split('\n').length - 1;

function writeUnit(
  content: readonly NodeJson[],
  kind: InlineKind,
  sites: Sites,
): { lines: Line[]; boundaries: { line: number; site: number }[] } {
  const raw = new TokenWriter(kind, sites).write(content);
  const clean = kind === 'paragraph' ? cleanBreaks(raw) : new Set<number>();
  const tokens = touchingMarkers(raw, sites);
  const pieces: Piece[] = [];
  const boundaries: { line: number; site: number }[] = [];
  let newlines = 0;
  const fixed = (value: string) => {
    pieces.push(value);
    newlines += countNewlines(value);
  };
  let lineHasContent = false;
  tokens.forEach((token, index) => {
    switch (token.kind) {
      case 'text': {
        const context = {
          kind,
          lineStart: !lineHasContent,
          // A neighbour needs a reference only where flanking is in doubt.
          afterDelimiter: isDelimiter(tokens[index - 1]) && !obviouslyFlanks(tokens, index - 1),
          beforeDelimiter: isDelimiter(tokens[index + 1]) && !obviouslyFlanks(tokens, index + 1),
          nextCharacter: firstCharacter(tokens[index + 1]),
        };
        for (const piece of textPieces(token.value, context, sites)) {
          if (typeof piece === 'string') fixed(piece);
          else pieces.push(piece);
        }
        if (token.value !== '') lineHasContent = true;
        return;
      }
      case 'fixed':
        // HTML that starts a line may start an HTML block.
        if (!lineHasContent && /^</.test(token.value)) sites.needsCheck = true;
        fixed(token.value);
        if (token.value !== '') lineHasContent = true;
        return;
      case 'site':
        pieces.push(token.piece);
        lineHasContent = true;
        return;
      case 'break':
        fixed(token.value);
        lineHasContent = !token.value.endsWith('\n');
        if (clean.has(index)) boundaries.push({ line: newlines, site: sites.count });
        return;
      default:
        if (!obviouslyFlanks(tokens, index)) sites.needsCheck = true;
        fixed(token.delim);
        // What follows a mark's delimiter is not at the line's start.
        lineHasContent = true;
    }
  });
  return { lines: splitLines(pieces), boundaries };
}

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
 * whitespace at the start of a line is a character reference, because the
 * parser strips it from every line; an empty line inside a paragraph is
 * `&#x20;`, because a blank line would end the paragraph; a code span's fence
 * is one backtick longer than the longest run inside it.
 */
import { MARK, NODE, UnknownNodeError, attr, type MarkJson, type NodeJson } from './docJson';
import { markKey, type InlineKind } from './normalize';
import { splitLines, type Line, type Piece, type SitePiece, type Sites } from './pieces';

type Token =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'fixed'; readonly value: string }
  | { readonly kind: 'site'; readonly piece: SitePiece }
  | { readonly kind: 'break'; readonly value: string; readonly soft: boolean }
  | {
      readonly kind: 'open' | 'close';
      readonly type: string;
      readonly delim: string;
      readonly pair: number;
    };

/** Opening order among marks that start together and run equally long: outermost first. */
const RANK: Partial<Record<string, number>> = {
  [MARK.strike]: 0,
  [MARK.strong]: 1,
  [MARK.emphasis]: 2,
  [MARK.link]: 3,
};

const ATTENTION: Partial<Record<string, string>> = {
  [MARK.strong]: '**',
  [MARK.emphasis]: '*',
  [MARK.strike]: '~~',
};

const reference = (character: string): string =>
  `&#x${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()};`;

const isAsciiPunctuation = (character: string): boolean => /^[!-/:-@[-`{-~]$/.test(character);

/** A code span one backtick longer than the longest run inside, padded where CommonMark strips. */
function codeSpan(value: string, inCell: boolean): string {
  const content = inCell ? value.replace(/\|/g, '\\|') : value;
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad =
    /^`|`$/.test(content) || (/^ /.test(content) && / $/.test(content) && !/^ +$/.test(content));
  return pad ? `${fence} ${content} ${fence}` : `${fence}${content}${fence}`;
}

/** A `|` in a table cell, as `\|`: the row is split at every other one before anything is read. */
const cellPipes = (text: string, inCell: boolean): string =>
  inCell ? text.replace(/\|/g, '\\|') : text;

/**
 * A link or image destination: bare when CommonMark reads it back unchanged (no
 * space, control character or backslash, not starting with `<`, parentheses
 * balanced), `<…>` otherwise.
 */
export function destination(url: string, inCell = false): string {
  const bare = /^[^\s\\\p{Cc}]*$/u.test(url) && !url.startsWith('<');
  if (bare && balancedParentheses(url)) return cellPipes(url, inCell);
  return cellPipes(`<${url.replace(/[\\<>]/g, '\\$&')}>`, inCell);
}

function balancedParentheses(url: string): boolean {
  let depth = 0;
  for (const character of url) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function titlePart(title: unknown, inCell: boolean): string {
  if (typeof title !== 'string' || title === '') return '';
  return cellPipes(` "${title.replace(/["\\]/g, '\\$&')}"`, inCell);
}

/** Every character that could be link-label syntax, escaped — only for a `www.` link written in full. */
const escapeLabel = (text: string): string => text.replace(/[\\`*_[\]<>&~|!]/g, '\\$&');

/**
 * The two spellings of a link whose text is its own URL, or null for any other
 * link: bare (what the house style writes) and the full form a parse falls
 * back to.
 */
function bareLinkOptions(text: string, mark: MarkJson, inCell: boolean): [string, string] | null {
  const href = attr<string>(mark, 'href') ?? '';
  if (attr<string | null>(mark, 'title')) return null;
  if (/[\s<>]/.test(text)) return null;
  const cell = (value: string) => cellPipes(value, inCell);
  if (href === text && /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\p{Cc}]*$/u.test(href)) {
    return [cell(text), cell(`<${href}>`)];
  }
  if (href === `mailto:${text}` && /^[^\s<>@]+@[^\s<>@]+$/.test(text)) {
    return [cell(text), cell(`<${text}>`)];
  }
  if (href === `http://${text}` && /^www\./i.test(text)) {
    return [cell(text), `[${escapeLabel(text)}](${destination(href, inCell)})`];
  }
  return null;
}

interface Run {
  readonly mark: MarkJson;
  readonly length: number;
}

/** How many runs from `index` on carry `mark`. */
function runLength(nodes: readonly NodeJson[], index: number, mark: MarkJson): number {
  const key = markKey(mark);
  let end = index;
  while (end < nodes.length && (nodes[end]?.marks ?? []).some((m) => markKey(m) === key)) end += 1;
  return end - index;
}

class TokenWriter {
  readonly tokens: Token[] = [];
  private readonly open: MarkJson[] = [];
  private readonly pairs: number[] = [];
  private nextPair = 0;

  constructor(
    private readonly kind: InlineKind,
    private readonly sites: Sites,
  ) {}

  write(nodes: readonly NodeJson[]): Token[] {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index] as NodeJson;
      const marks = (node.marks ?? []).filter((mark) => mark.type !== MARK.code);
      this.closeAllBut(marks);
      const opening = this.opening(nodes, index, marks);
      const link = opening.find((run) => run.mark.type === MARK.link);
      const bare =
        link && link.length === 1 && node.type === NODE.text && !this.hasCode(node)
          ? bareLinkOptions(node.text ?? '', link.mark, this.kind === 'cell')
          : null;
      for (const run of opening) {
        if (bare && run === link) continue;
        this.openMark(run.mark);
      }
      if (bare) this.tokens.push({ kind: 'site', piece: this.sites.piece(bare) });
      else this.body(node);
    }
    this.closeAllBut([]);
    return this.tokens;
  }

  private hasCode(node: NodeJson): boolean {
    return (node.marks ?? []).some((mark) => mark.type === MARK.code);
  }

  /** The marks `marks` adds to the open ones, outermost first. */
  private opening(nodes: readonly NodeJson[], index: number, marks: readonly MarkJson[]): Run[] {
    const openKeys = new Set(this.open.map(markKey));
    return marks
      .filter((mark) => !openKeys.has(markKey(mark)))
      .map((mark) => ({ mark, length: runLength(nodes, index, mark) }))
      .sort((a, b) => b.length - a.length || (RANK[a.mark.type] ?? 9) - (RANK[b.mark.type] ?? 9));
  }

  /** Closes open marks from the innermost out until every one left is in `marks`. */
  private closeAllBut(marks: readonly MarkJson[]): void {
    const keys = new Set(marks.map(markKey));
    let keep = 0;
    while (keep < this.open.length && keys.has(markKey(this.open[keep] as MarkJson))) keep += 1;
    while (this.open.length > keep) {
      const mark = this.open.pop() as MarkJson;
      const pair = this.pairs.pop() as number;
      if (mark.type === MARK.link) {
        const inCell = this.kind === 'cell';
        const href = destination(attr<string>(mark, 'href') ?? '', inCell);
        const title = titlePart(attr<string | null>(mark, 'title'), inCell);
        this.tokens.push({ kind: 'close', type: mark.type, delim: `](${href}${title})`, pair });
      } else {
        this.tokens.push({
          kind: 'close',
          type: mark.type,
          delim: ATTENTION[mark.type] ?? '',
          pair,
        });
      }
    }
  }

  private openMark(mark: MarkJson): void {
    const delim = mark.type === MARK.link ? '[' : ATTENTION[mark.type];
    if (delim === undefined) throw new UnknownNodeError(`mark:${mark.type}`);
    const pair = this.nextPair++;
    this.tokens.push({ kind: 'open', type: mark.type, delim, pair });
    this.open.push(mark);
    this.pairs.push(pair);
  }

  private body(node: NodeJson): void {
    const fixed = (value: string) => this.tokens.push({ kind: 'fixed', value });
    switch (node.type) {
      case NODE.text:
        if (this.hasCode(node)) {
          const span = codeSpan(node.text ?? '', this.kind === 'cell');
          // Spelled the same anywhere — except a ``` run, which could open a fence.
          if (span.startsWith('```')) this.sites.needsCheck = true;
          fixed(span);
        } else {
          this.tokens.push({ kind: 'text', value: node.text ?? '' });
        }
        return;
      case NODE.hardbreak: {
        const soft = node.attrs?.isInline === true;
        const value = this.kind === 'cell' ? '<br>' : soft ? '\n' : '\\\n';
        this.tokens.push({ kind: 'break', value, soft: soft && this.kind !== 'cell' });
        return;
      }
      case NODE.image: {
        this.sites.needsCheck = true;
        const inCell = this.kind === 'cell';
        fixed('![');
        this.tokens.push({ kind: 'text', value: attr<string>(node, 'alt') ?? '' });
        const src = destination(attr<string>(node, 'src') ?? '', inCell);
        fixed(`](${src}${titlePart(attr(node, 'title'), inCell)})`);
        return;
      }
      case NODE.html:
        fixed(attr<string>(node, 'value') ?? '');
        return;
      case NODE.wikilink: {
        const target = attr<string>(node, 'target') ?? '';
        fixed(`[[${this.kind === 'cell' ? escapeCellPipes(target) : target}]]`);
        return;
      }
      case NODE.footnoteReference:
        fixed(`[^${attr<string>(node, 'label') ?? ''}]`);
        return;
      default:
        throw new UnknownNodeError(node.type);
    }
  }
}

/**
 * A `|` inside a wikilink in a table cell, as `\|` — and one after an odd run
 * of backslashes gets one more, so the run reads back as escaped backslashes
 * (the app's wikilink tokenizer reads `\|` back as `|` inside a table).
 */
function escapeCellPipes(target: string): string {
  return target.replace(/(\\*)\|/g, (_pipe, run: string) =>
    run.length % 2 === 1 ? `${run}\\\\|` : `${run}\\|`,
  );
}

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

/** What can follow `&` in a character reference (`&amp;`, `&#38;`, `&#x26;`). */
const REFERENCE_TAIL = /^(?:#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]{1,31};)/;
/** …and the ones that only can as a line's first character. */
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
  start: number,
  context: TextContext & { kind: InlineKind; every: boolean },
): boolean {
  const character = characters[index] as string;
  if (!isAsciiPunctuation(character)) return false;
  if (context.every || ALWAYS.has(character)) return true;
  const atLineStart = context.lineStart && index === start;
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
    return /^\d{1,9}$/.test(characters.slice(start, index).join(''));
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
  let start = 0;
  if (context.lineStart) {
    while (start < characters.length && /[ \t]/.test(characters[start] as string)) {
      fixed += reference(characters[start] as string);
      start += 1;
    }
  }
  const every = sites.scope === 'every';
  for (let index = start; index < characters.length; index += 1) {
    const character = characters[index] as string;
    const edge =
      (index === 0 && context.afterDelimiter) ||
      (index === characters.length - 1 && context.beforeDelimiter);
    const escapable = plausible(characters, index, start, { ...context, every });
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

function lastCharacter(token: Token | undefined): string | undefined {
  if (!token) return undefined;
  if (token.kind === 'text' || token.kind === 'fixed' || token.kind === 'break') {
    return token.value.slice(-1) || undefined;
  }
  if (token.kind === 'site') return token.piece.options[0].slice(-1);
  return token.delim.slice(-1);
}

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

function firstCharacter(token: Token | undefined): string | undefined {
  if (!token) return undefined;
  if (token.kind === 'text' || token.kind === 'fixed' || token.kind === 'break') {
    return token.value.charAt(0) || undefined;
  }
  if (token.kind === 'site') return token.piece.options[0].charAt(0);
  return token.delim.charAt(0);
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
        // A blank line would end the paragraph: an empty line holds one reference.
        if (token.soft && !lineHasContent) fixed('&#x20;');
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

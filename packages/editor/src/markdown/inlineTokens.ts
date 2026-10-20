import { MARK, NODE, UnknownNodeError, attr, type MarkJson, type NodeJson } from './docJson';
import { markKey, type InlineKind } from './normalize';
import { type SitePiece, type Sites } from './pieces';

export type Token =
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
export const RANK: Partial<Record<string, number>> = {
  [MARK.strike]: 0,
  [MARK.strong]: 1,
  [MARK.emphasis]: 2,
  [MARK.link]: 3,
};

export const ATTENTION: Partial<Record<string, string>> = {
  [MARK.strong]: '**',
  [MARK.emphasis]: '*',
  [MARK.strike]: '~~',
};

export const reference = (character: string): string =>
  `&#x${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()};`;

export const isAsciiPunctuation = (character: string): boolean =>
  /^[!-/:-@[-`{-~]$/.test(character);

/** What can follow `&` in a character reference (`&amp;`, `&#38;`, `&#x26;`). */
export const REFERENCE_TAIL = /^(?:#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]{1,31};)/;

/**
 * A destination or title with each `&` that would start a character reference
 * written `\&`, so a decoded `&amp;` is not decoded again on the next read. A
 * `&` that starts none stays bare.
 */
export const escapeReferences = (value: string): string =>
  value.replace(/&/g, (amp, at: number) =>
    REFERENCE_TAIL.test(value.slice(at + 1, at + 40)) ? `\\${amp}` : amp,
  );

/** A `|` in a table cell, as `\|`: the row is split at every other one before anything is read. */
export const cellPipes = (text: string, inCell: boolean): string =>
  inCell ? text.replace(/\|/g, '\\|') : text;

/** A code span one backtick longer than the longest run inside, padded where CommonMark strips. */
export function codeSpan(value: string, inCell: boolean): string {
  const content = cellPipes(value, inCell);
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad =
    /^`|`$/.test(content) || (/^ /.test(content) && / $/.test(content) && !/^ +$/.test(content));
  return pad ? `${fence} ${content} ${fence}` : `${fence}${content}${fence}`;
}

/**
 * A link or image destination: bare when CommonMark reads it back unchanged (no
 * space, control character or backslash, not starting with `<`, parentheses
 * balanced), `<…>` otherwise.
 */
export function destination(url: string, inCell = false): string {
  const bare = /^[^\s\\\p{Cc}]*$/u.test(url) && !url.startsWith('<');
  if (bare && balancedParentheses(url)) return cellPipes(escapeReferences(url), inCell);
  return cellPipes(`<${escapeReferences(url.replace(/[\\<>]/g, '\\$&'))}>`, inCell);
}

export function balancedParentheses(url: string): boolean {
  let depth = 0;
  for (const character of url) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

export function titlePart(title: unknown, inCell: boolean): string {
  if (typeof title !== 'string' || title === '') return '';
  return cellPipes(` "${escapeReferences(title.replace(/["\\]/g, '\\$&'))}"`, inCell);
}

/** Every character that could be link-label syntax, escaped — only for a `www.` link written in full. */
export const escapeLabel = (text: string): string => text.replace(/[\\`*_[\]<>&~|!]/g, '\\$&');

/**
 * The two spellings of a link whose text is its own URL, or null for any other
 * link: bare (what the house style writes) and the full form a parse falls
 * back to.
 */
export function bareLinkOptions(
  text: string,
  mark: MarkJson,
  inCell: boolean,
): [string, string] | null {
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

export interface Run {
  readonly mark: MarkJson;
  readonly length: number;
}

/** How many runs from `index` on carry `mark`. */
export function runLength(nodes: readonly NodeJson[], index: number, mark: MarkJson): number {
  const key = markKey(mark);
  let end = index;
  while (end < nodes.length && (nodes[end]?.marks ?? []).some((m) => markKey(m) === key)) end += 1;
  return end - index;
}

export class TokenWriter {
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
export function escapeCellPipes(target: string): string {
  return target.replace(/(\\*)\|/g, (_pipe, run: string) =>
    run.length % 2 === 1 ? `${run}\\\\|` : `${run}\\|`,
  );
}

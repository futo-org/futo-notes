/*
 * Compat fix: bold or italic whose inner edge is punctuation and whose outer
 * neighbour is a letter saved as literal asterisks.
 *
 * A delimiter run only opens or closes emphasis when it is left- or
 * right-flanking (CommonMark §6.2): `**Note:**bar` is neither at its closing
 * `**` (punctuation before it, a letter after it), so it reads back as the text
 * `**Note:**bar`, and the next save escapes that to `\*\*Note:\*\*bar` — the
 * formatting permanently turned into characters. Every CJK phrase that ends in
 * full-width punctuation (a full-width colon, say) and runs on into more text
 * hits it, since CJK puts no space there.
 *
 * `mdast-util-to-markdown` already knows the answer: its `strong` and `emphasis`
 * handlers ask `encodeInfo` which neighbour to write as a character reference
 * (`**Note:**&#x62;ar`, which every CommonMark reader reads back as bold). But
 * `@milkdown/core` REPLACES both handlers with its own
 * (`src/__internal__/remark-handlers.ts`, 7.22.1) — to keep the per-node
 * `marker`, `*` or `_` — and those skip the encoding. So this wraps Milkdown's
 * handlers and applies upstream's `encodeInfo` to what they wrote: the inner
 * edge characters here, the outer ones through
 * `state.attentionEncodeSurroundingInfo`, which upstream's `containerPhrasing`
 * reads after each child exactly as it does for its own handlers.
 * GFM strikethrough has the same hole one package over — its `delete` handler
 * never encoded at all — and gets the same wrapper ({@link strikethroughHandler}).
 *
 * Characters are classified per UTF-16 unit, the way micromark's parser sees
 * them (an emoji's lead surrogate is a "letter" to it), so the verdict matches
 * how the note will read back. Unlike upstream, a character that has to be
 * encoded is encoded as its whole code point, and an OUTER neighbour that is
 * half a surrogate pair is left alone: `containerPhrasing` encodes one UTF-16
 * unit, and a reference to a lone surrogate reads back as U+FFFD — losing a
 * character is worse than losing the formatting, which is what happens today.
 *
 * Same carve-out as the rest of this directory: an adapter for one library's
 * handler override, not a note rule (packages/editor/AGENTS.md). Typed
 * structurally for the reason `stringifyHandlers.ts` gives.
 */
import type { MilkdownPlugin, SliceType } from '@milkdown/kit/ctx';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';

/** The serializer-state field this wrapper writes. */
export interface AttentionState {
  attentionEncodeSurroundingInfo?: { before: boolean; after: boolean } | undefined;
}

/** The neighbour context remark hands a phrasing handler. */
export interface AttentionInfo {
  before: string;
  after: string;
}

type Group = 'whitespace' | 'punctuation' | 'other';

/** micromark's `classifyCharacter` for one UTF-16 unit. */
function classify(unit: number): Group {
  const character = String.fromCharCode(unit);
  if (/\s/.test(character)) return 'whitespace';
  if (/\p{P}|\p{S}/u.test(character)) return 'punctuation';
  return 'other';
}

/**
 * Upstream's `encodeInfo` (`mdast-util-to-markdown/lib/util/encode-info.js`),
 * verbatim in logic: which side of an attention run to encode so it forms.
 */
function encodeInfo(outside: number, inside: number, marker: string) {
  const outsideGroup = classify(outside);
  const insideGroup = classify(inside);
  if (outsideGroup === 'other') {
    if (insideGroup === 'other') {
      return marker === '_' ? { inside: true, outside: true } : { inside: false, outside: false };
    }
    return insideGroup === 'whitespace'
      ? { inside: true, outside: true }
      : { inside: false, outside: true };
  }
  if (outsideGroup === 'whitespace') {
    return insideGroup === 'whitespace'
      ? { inside: true, outside: true }
      : { inside: false, outside: false };
  }
  return insideGroup === 'whitespace'
    ? { inside: true, outside: false }
    : { inside: false, outside: false };
}

const isSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdfff;

const reference = (codePoint: number): string => `&#x${codePoint.toString(16).toUpperCase()};`;

/** `text` with its first character (a whole code point) written as a reference. */
function encodeHead(text: string): string {
  const codePoint = text.codePointAt(0);
  if (codePoint === undefined) return text;
  return reference(codePoint) + text.slice(codePoint > 0xffff ? 2 : 1);
}

/** `text` with its last character (a whole code point) written as a reference. */
function encodeTail(text: string): string {
  if (text === '') return text;
  const last = text.charCodeAt(text.length - 1);
  const pair = last >= 0xdc00 && last <= 0xdfff && text.length > 1;
  const start = pair ? text.length - 2 : text.length - 1;
  return text.slice(0, start) + reference(text.codePointAt(start) ?? last);
}

/** Whether `text` is exactly one character (a code point, so a surrogate pair counts once). */
function isSingleCharacter(text: string): boolean {
  const codePoint = text.codePointAt(0);
  return codePoint !== undefined && text.length === (codePoint > 0xffff ? 2 : 1);
}

/**
 * The delimiter a missing neighbour stands in for. An empty `before` or `after`
 * is not a character: `@milkdown/transformer` trims a mark's edge spaces out of
 * the mark and leaves the emptied text node behind (`moveSpaces`), so the first
 * or last child of a link, bold or italic can be `''`, and `containerPhrasing`
 * then passes the next sibling `before: ''`. What sits there is the enclosing
 * construct's own delimiter (`[`, `](`, `*`, `~`) — always punctuation, never
 * something that can be written as a reference. Classified as nothing at all
 * (`NaN`) it counted as a letter, and the container, comparing `''` with the
 * empty previous result, wrote `&#xNAN;` (RC-104).
 */
const DELIMITER = 0x5b; // `[`

/** The UTF-16 unit `text` ends with (`last`) or starts with, or a delimiter when there is none. */
function unitAt(text: string, last: boolean): number {
  return text === '' ? DELIMITER : text.charCodeAt(last ? text.length - 1 : 0);
}

/** Where an attention run written as `written` sits, and what it would need encoded. */
function flanking(written: string, size: 1 | 2, info: AttentionInfo, marker = written.charAt(0)) {
  const between = written.slice(size, written.length - size);
  const before = unitAt(info.before, true);
  const after = unitAt(info.after, false);
  const open = encodeInfo(before, between.charCodeAt(0), marker);
  const close = encodeInfo(after, between.charCodeAt(between.length - 1), marker);
  const encodes = open.inside || open.outside || close.inside || close.outside;
  return { between, before, after, open, close, encodes };
}

/**
 * Milkdown's `strong` (`size` 2) or `emphasis` (`size` 1) handler — or
 * {@link strikethroughHandler} — with upstream's flanking encoding applied to
 * what it wrote.

 */
export function withAttentionEncoding<
  Node,
  Parent,
  State extends AttentionState,
  Info extends AttentionInfo,
>(
  base: (node: Node, parent: Parent, state: State, info: Info) => string,
  size: 1 | 2,
): ((node: Node, parent: Parent, state: State, info: Info) => string) & { peek: typeof base } {
  const handler = (node: Node, parent: Parent, state: State, info: Info): string => {
    const written = base(node, parent, state, info);
    if (written.length <= 2 * size) return written;

    const { before, after, open, close, ...run } = flanking(written, size, info);
    let between = run.between;
    if (open.inside) between = encodeHead(between);
    /* One character that both edges want encoded is written once: encoding the
     * tail of `&#x61;` cut the reference in two (`&#x61&#x3B;`). */
    if (close.inside && !(open.inside && isSingleCharacter(run.between))) {
      between = encodeTail(between);
    }

    /* Never ask the container to encode a neighbour that is not there: it
     * compares `''` with the empty previous result and writes `&#xNAN;`. */
    state.attentionEncodeSurroundingInfo = {
      before: open.outside && info.before !== '' && !isSurrogate(before),
      after: close.outside && info.after !== '' && !isSurrogate(after),
    };
    return written.slice(0, size) + between + written.slice(written.length - size);
  };
  /* `containerPhrasing` learns a sibling's first character by calling its
   * handler's `peek`, or the whole handler when there is none — and Milkdown's
   * have none. Without this the lookahead call would leave its
   * `attentionEncodeSurroundingInfo` behind for the PREVIOUS sibling, which then
   * encoded this run's own opening marker (`&#x2A;(b)*`). */
  return Object.assign(handler, { peek: base });
}

type StringifyOptions =
  typeof remarkStringifyOptionsCtx extends SliceType<infer Options> ? Options : never;
/** A `mdast-util-to-markdown` node handler, as the stringify options type it. */
type Handle = NonNullable<NonNullable<StringifyOptions['handlers']>['strong']>;

/**
 * `mdast-util-gfm-strikethrough`'s `handleDelete`, restated so it can be
 * wrapped: GFM strikethrough flanks by the same rule as `*`, and upstream's
 * handler has no `encodeInfo` at all, so `~~Note:~~bar` (Mod+Alt+X on `Note:`)
 * reopened as literal tildes. That handler is registered by the gfm
 * to-markdown extension, not in the stringify options, so there is no function
 * here to wrap — and that package reaches this one only transitively (see
 * `stringifyHandlers.ts` on phantom imports).
 */
const strikethroughHandler: Handle = (node, _parent, state, info) => {
  const tracker = state.createTracker(info);
  // Upstream's own construct name (its `unsafe` `~` rule is keyed on it); the
  // type registering it is declared by that package, which is not imported.
  const exit = state.enter('strikethrough' as Parameters<typeof state.enter>[0]);
  let value = tracker.move('~~');
  value += state.containerPhrasing(node, { ...tracker.current(), before: value, after: '~' });
  value += tracker.move('~~');
  exit();
  return value;
};

/**
 * Installs the wrapper over Milkdown's `strong` and `emphasis` handlers (and
 * over {@link strikethroughHandler} as `delete`: stringify-option handlers
 * are applied after the extensions', so this one wins), in the
 * plugin's prepare phase for the reason `blankLineJoinPlugin` gives. If
 * Milkdown ever stops overriding them, upstream's own handlers already encode
 * and there is nothing to wrap — the compat spec's canary goes red first.
 */
export const attentionEncodingPlugin: MilkdownPlugin = (ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (options) => {
    const { strong, emphasis } = options.handlers ?? {};
    if (!strong || !emphasis) return options;
    return {
      ...options,
      handlers: {
        ...options.handlers,
        strong: withAttentionEncoding(strong, 2),
        emphasis: withAttentionEncoding(emphasis, 1),
        delete: withAttentionEncoding(strikethroughHandler, 2),
      },
    };
  });
  return () => {};
};

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
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
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

/** micromark's `classifyCharacter` for one UTF-16 unit (`NaN`: nothing there). */
function classify(unit: number): Group {
  if (Number.isNaN(unit)) return 'other';
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
  const codePoint = text.codePointAt(0) ?? 0;
  return reference(codePoint) + text.slice(codePoint > 0xffff ? 2 : 1);
}

/** `text` with its last character (a whole code point) written as a reference. */
function encodeTail(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  const pair = last >= 0xdc00 && last <= 0xdfff && text.length > 1;
  const start = pair ? text.length - 2 : text.length - 1;
  return text.slice(0, start) + reference(text.codePointAt(start) ?? last);
}

/**
 * Milkdown's `strong` (`size` 2) or `emphasis` (`size` 1) handler with
 * upstream's flanking encoding applied to what it wrote.
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
    const marker = written.charAt(0);
    let between = written.slice(size, written.length - size);
    if (between === '') return written;

    const before = info.before.charCodeAt(info.before.length - 1);
    const open = encodeInfo(before, between.charCodeAt(0), marker);
    if (open.inside) between = encodeHead(between);
    const after = info.after.charCodeAt(0);
    const close = encodeInfo(after, between.charCodeAt(between.length - 1), marker);
    if (close.inside) between = encodeTail(between);

    state.attentionEncodeSurroundingInfo = {
      before: open.outside && !isSurrogate(before),
      after: close.outside && !isSurrogate(after),
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

/**
 * Installs the wrapper over Milkdown's `strong` and `emphasis` handlers, in the
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
      },
    };
  });
  return () => {};
};

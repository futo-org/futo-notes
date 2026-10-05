/*
 * Wrappers around remark-stringify's node handlers.
 *
 * `mdast-util-to-markdown` merges an extension's `unsafe` patterns by pushing
 * them onto its own list — there is no hook that REMOVES one. Handlers, by
 * contrast, are merged with `Object.assign`, so replacing a handler is the
 * supported way to change how a node's text is escaped. Each wrapper here
 * therefore calls the handler it wraps with a shallow copy of the serializer
 * state carrying a different `unsafe` list; every other field (`stack`,
 * `safe`, `compilePattern`, …) is the same object, so scope tracking and the
 * compiled-pattern caches are untouched.
 *
 * The state is a type PARAMETER rather than an interface this package
 * declares: the wrapped handler needs the real serializer state, and this
 * package does not depend on `mdast-util-to-markdown` (it arrives only as a
 * transitive dependency of `@milkdown/kit`, so importing it here would be a
 * phantom dependency). Inferring the state from the handler being wrapped
 * gives the caller full type-checking without either the import or a cast.
 */
import { narrowAtxHashEscape, type UnsafePattern } from './atxEscape';
import {
  escapeDelimiterUnderscores,
  isBlanketPhrasingUnderscore,
  withoutPhrasingUnderscoreEscape,
} from './underscoreEscape';

/** The serializer-state field these wrappers touch. */
export interface HasUnsafePatterns {
  unsafe: UnsafePattern[];
}

/**
 * `base`, but escaping a line-leading `#` only when it would actually start an
 * ATX heading — so `#tag` survives a save. See `atxEscape.ts` for why the
 * stock rule loses tags.
 */
export function withNarrowedAtxHashEscape<
  Node,
  Parent,
  State extends HasUnsafePatterns,
  Info,
  Result,
>(
  base: (node: Node, parent: Parent, state: State, info: Info) => Result,
): (node: Node, parent: Parent, state: State, info: Info) => Result {
  return (node, parent, state, info) =>
    base(node, parent, { ...state, unsafe: narrowAtxHashEscape(state.unsafe) }, info);
}

/** The serializer-state fields `withNarrowedEscapes` reads. */
export interface TextHandlerState extends HasUnsafePatterns {
  /** The constructs being written, innermost last (`ConstructName[]` upstream). */
  stack: readonly string[];
  /** Upstream's escaper, bound to the state it is called on (`safeBound`). */
  safe(value: string, config: { before: string; after: string; encode?: string[] }): string;
}

/** The neighbour context remark hands its `text` handler. */
export interface TextHandlerInfo {
  before?: string;
  after?: string;
}

/** The mdast `text` node field these wrappers read. */
export interface TextHandlerNode {
  value: string;
}

/**
 * `@milkdown/core`'s raw-return condition, verbatim from its `text` handler
 * (`src/__internal__/remark-handlers.ts`, 7.22.1): a run that ends in
 * whitespace and holds no `*`, `_` or `\` is returned as-is, BEFORE `safe()`.
 * The shortcut exists to keep a trailing space from being written as `&#x20;`
 * (upstream encodes a space before a line ending), but it skips every OTHER
 * escape in the run too. A run ends in whitespace whenever the next inline
 * sibling is not text — a mark, a link, a wikilink, an image, inline HTML — or
 * the user paused after typing a space, so `\# a **b**` saved as a heading,
 * ` x | y ` typed in a cell split the row, and `&amp; ` decoded to `&`.
 */
const MILKDOWN_RAW_TEXT_RUN = /^[^*_\\]*\s+$/;

/**
 * The `text` handler with every escape this package narrows: the line-leading
 * `#` (`./atxEscape`) and the intra-word `_` (`./underscoreEscape`). This is the
 * wrapper the editor and the round-trip census both install, so "what the app
 * writes" is defined in exactly one place.
 *
 * The `_` half runs AFTER `base`, over what it wrote: the blanket rule is taken
 * out of the list `safe()` sees and each underscore is then judged on its own
 * neighbours (why that and not two conditioned patterns: underscoreEscape.ts).
 * It applies exactly where the removed rule did — in phrasing, and not inside
 * the constructs that rule excluded (autolinks, link destinations, reference
 * labels, titles), read off the pattern itself so the two cannot drift.
 *
 * Two runs never reach `base`:
 *
 * - The text of an autolink (`<https://…>`) is written verbatim. CommonMark
 *   processes no backslash escapes inside `<…>`, so a `\` there is part of the
 *   URL — yet upstream `safe()` still doubles a backslash that precedes
 *   punctuation, and the next open read both as literal: `a\.b` grew 1 → 2 →
 *   4 → … backslashes on every save. Nothing else needs escaping there either:
 *   the link handler only picks the autolink form for a URL with no space,
 *   `<`, `>` or control character in it.
 * - A run Milkdown would return raw ({@link MILKDOWN_RAW_TEXT_RUN}) goes through
 *   `safe()` minus its trailing whitespace, which is judged as the context
 *   after it and appended untouched — every escape the run needs, and still no
 *   `&#x20;`.
 */
export function withNarrowedEscapes<
  Node extends TextHandlerNode,
  Parent,
  State extends TextHandlerState,
  Info extends TextHandlerInfo,
>(
  base: (node: Node, parent: Parent, state: State, info: Info) => string,
): (node: Node, parent: Parent, state: State, info: Info) => string {
  return (node, parent, state, info) => {
    if (state.stack.includes('autolink')) return node.value;
    const blanket = state.unsafe.find(isBlanketPhrasingUnderscore);
    const unsafe = narrowAtxHashEscape(withoutPhrasingUnderscoreEscape(state.unsafe));
    const narrowed = { ...state, unsafe };
    const written = MILKDOWN_RAW_TEXT_RUN.test(node.value)
      ? safeKeepingTrailingWhitespace(narrowed, node.value, info)
      : base(node, parent, narrowed, info);
    if (!blanket || !appliesIn(blanket, state.stack)) return written;
    return escapeDelimiterUnderscores(written, info.before, info.after);
  };
}

/**
 * `value` through `safe()` exactly as Milkdown's handler calls it, except that
 * its trailing whitespace is left out of the escaping and written raw. The
 * whitespace is still handed to `safe()` as the context after the run, so a
 * character next to it is judged against its real neighbour.
 */
function safeKeepingTrailingWhitespace(
  state: TextHandlerState,
  value: string,
  info: TextHandlerInfo,
): string {
  const body = value.replace(/\s+$/, '');
  const trailing = value.slice(body.length);
  const context = { ...info, before: info.before ?? '', after: trailing + (info.after ?? '') };
  return state.safe(body, { ...context, encode: [] }) + trailing;
}

/**
 * Whether an `unsafe` pattern's construct conditions hold for `stack` —
 * upstream's own `patternInScope`, which that package does not export.
 */
export function appliesIn(pattern: UnsafePattern, stack: readonly string[]): boolean {
  const list = (value: UnsafePattern['inConstruct']): readonly string[] =>
    value == null ? [] : typeof value === 'string' ? [value] : value;
  const inConstruct = list(pattern.inConstruct);
  const notInConstruct = list(pattern.notInConstruct);
  if (inConstruct.length > 0 && !inConstruct.some((name) => stack.includes(name))) return false;
  return !notInConstruct.some((name) => stack.includes(name));
}

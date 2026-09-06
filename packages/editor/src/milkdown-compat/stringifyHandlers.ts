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
}

/** The neighbour context remark hands its `text` handler. */
export interface TextHandlerInfo {
  before?: string;
  after?: string;
}

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
 */
export function withNarrowedEscapes<Node, Parent, State extends TextHandlerState>(
  base: (node: Node, parent: Parent, state: State, info: TextHandlerInfo) => string,
): (node: Node, parent: Parent, state: State, info: TextHandlerInfo) => string {
  return (node, parent, state, info) => {
    const blanket = state.unsafe.find(isBlanketPhrasingUnderscore);
    const unsafe = narrowAtxHashEscape(withoutPhrasingUnderscoreEscape(state.unsafe));
    const written = base(node, parent, { ...state, unsafe }, info);
    if (!blanket || !appliesIn(blanket, state.stack)) return written;
    return escapeDelimiterUnderscores(written, info.before, info.after);
  };
}

/** Whether an `unsafe` pattern's construct conditions hold for `stack`. */
function appliesIn(pattern: UnsafePattern, stack: readonly string[]): boolean {
  const list = (value: UnsafePattern['inConstruct']): readonly string[] =>
    value == null ? [] : typeof value === 'string' ? [value] : value;
  const inConstruct = list(pattern.inConstruct);
  const notInConstruct = list(pattern.notInConstruct);
  if (inConstruct.length > 0 && !inConstruct.some((name) => stack.includes(name))) return false;
  return !notInConstruct.some((name) => stack.includes(name));
}

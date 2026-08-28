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

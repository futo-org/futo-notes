/*
 * Compat fix: remark-stringify escapes a line-leading `#` that CommonMark
 * would never read as a heading, which destroys a tag.
 *
 * `mdast-util-to-markdown` ships one blanket rule — `{atBreak: true,
 * character: '#'}`, no `after` condition — so EVERY `#` that starts a line
 * comes back as `\#`. A note whose first line is the header tag block
 * `#alpha #beta` therefore saves as `\#alpha #beta` the first time the user
 * edits it, and `\#alpha` is no longer a tag to anything: not to our own rule
 * (`scanTags` needs whitespace or start-of-line before the `#`), not to the
 * desktop tag bar (`extractHeaderTagBlock` stops recognizing the block), not
 * to Obsidian. The tag is silently gone from the note.
 *
 * The escape is over-broad, not wrong-in-principle: an ATX heading is 1-6 `#`
 * followed by a space, a tab, or the end of the line. `#alpha` is none of
 * those, and neither is `#5` or `#######x`. {@link ATX_HASH_PATTERN} states
 * that condition, so a leading `#` is escaped exactly when leaving it alone
 * would turn a paragraph into a heading.
 *
 * Home per docs/plan/milkdown-transition.md §3 (entry 3): both hosts and the
 * corpus harness consume one copy. §3.7's M6 carve-out applies — this is an adapter
 * for a Milkdown/remark implementation detail, not a note rule, so it has no
 * Rust mirror. §3.6: report upstream.
 *
 * Typed structurally rather than against `mdast-util-to-markdown`, which this
 * package does not depend on — it reaches us only as a transitive dependency
 * of `@milkdown/kit`, and a phantom import would break the day Milkdown
 * changes its own dependency.
 */

/** One `mdast-util-to-markdown` "unsafe" pattern (the fields we read). */
export interface UnsafePattern {
  character: string;
  atBreak?: boolean | null | undefined;
  before?: string | null | undefined;
  after?: string | null | undefined;
}

/**
 * The blanket rule we replace: a line-leading `#` with no condition at all on
 * what follows it.
 */
function isBlanketAtxHash(pattern: UnsafePattern): boolean {
  return (
    pattern.character === '#' &&
    Boolean(pattern.atBreak) &&
    pattern.before == null &&
    pattern.after == null
  );
}

/**
 * A line-leading `#` needs escaping only when the run of `#` it starts (1-6 of
 * them, so at most five more) is followed by a space, a tab, or the end of the
 * line — i.e. exactly when CommonMark would read an ATX heading.
 *
 * Shared, not rebuilt per call: `compilePattern` memoizes the compiled RegExp
 * on the pattern object, and serialization runs this for every text node.
 */
export const ATX_HASH_PATTERN: UnsafePattern = {
  atBreak: true,
  character: '#',
  after: '#{0,5}(?:[\\t\\r\\n ]|$)',
};

/**
 * The same unsafe list with the blanket `#` rule replaced by the precise one.
 * Every other pattern is passed through by reference so its compiled-RegExp
 * cache survives.
 */
export function narrowAtxHashEscape(unsafe: readonly UnsafePattern[]): UnsafePattern[] {
  return unsafe.map((pattern) => (isBlanketAtxHash(pattern) ? ATX_HASH_PATTERN : pattern));
}

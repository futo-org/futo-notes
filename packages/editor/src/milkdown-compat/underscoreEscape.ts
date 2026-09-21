/*
 * Compat fix: remark-stringify escapes EVERY `_` in prose, including one that
 * sits inside a word and could never start or end emphasis — so a single
 * keystroke anywhere in a note rewrote `snake_case_word` as
 * `snake\_case\_word`, and `#dog_problems` came back as `#dog\_problems`,
 * which is a tag to nothing (the desktop tag bar then dropped every chip on the
 * note, since it commits through a full re-serialization — tests/tags.spec.ts).
 *
 * `mdast-util-to-markdown` ships one blanket rule for it — `{character: '_',
 * inConstruct: 'phrasing'}`, no condition on the neighbours. The precise rule is
 * CommonMark's own: a `_` can only OPEN emphasis when it is not preceded by an
 * alphanumeric, and only CLOSE it when it is not followed by one (spec §6.2,
 * the "intraword" exception that `*` does not have). A `_` with a word character
 * on both sides is therefore inert, and leaving it alone changes nothing about
 * how the note reads back.
 *
 * WHY A POST-PASS AND NOT TWO NARROWER `unsafe` PATTERNS. The obvious fix — a
 * `before`-conditioned pattern for openers and an `after`-conditioned one for
 * closers — was measured against the 31k-note census and made nine notes
 * UNSTABLE across saves. Two reasons, both inside `safe()`: a conditioned
 * pattern's RegExp consumes the neighbour it tests, so in a run like `____`
 * only every other underscore matched; and its "skip this escape when the next
 * character is definitely escaped" heuristic then left `__init__` as
 * `\__init_\_`, which CommonMark reads back as `\_` + *init* + `_` — emphasis
 * that was never there. So the blanket rule is REMOVED from the list handed to
 * `safe()` and every `_` in what it wrote is decided here, independently, from
 * its own two neighbours. A run of underscores comes out fully escaped, exactly
 * as stock remark writes it.
 *
 * "Word character" is ASCII alphanumeric on purpose: erring towards escaping (a
 * `_` next to `é` still gets its backslash) is the conservative side, and it is
 * what stock remark does today. The `atBreak` `_` rule — a line that starts with
 * `_` could be a thematic break — is left in the list and is a subset of this
 * pass anyway (a `_` after a newline is not preceded by a word character).
 *
 * Same home and same carve-out as `./atxEscape`: an adapter for one
 * serializer's over-broad escape, not a note rule (packages/editor/AGENTS.md).
 * Measured with `just milkdown-census --diff` before landing, as that file
 * requires.
 */
import type { UnsafePattern } from './atxEscape';

/**
 * The blanket rule this module takes over from `safe()`: a `_` in phrasing with
 * no condition on what is around it. (`inConstruct` is what distinguishes it
 * from the `atBreak` thematic-break rule, which stays.)
 */
export function isBlanketPhrasingUnderscore(pattern: UnsafePattern): boolean {
  return (
    pattern.character === '_' &&
    !pattern.atBreak &&
    pattern.before == null &&
    pattern.after == null &&
    pattern.inConstruct != null
  );
}

/** `unsafe` without the blanket phrasing `_` rule; everything else by reference. */
export function withoutPhrasingUnderscoreEscape(unsafe: readonly UnsafePattern[]): UnsafePattern[] {
  return unsafe.filter((pattern) => !isBlanketPhrasingUnderscore(pattern));
}

/** CommonMark's "alphanumeric" for the intraword rule, ASCII only (see above). */
function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /^[A-Za-z0-9]$/.test(character);
}

/**
 * `written` (a text node as `safe()` wrote it, every other escape already in
 * place) with a backslash before each `_` that could open or close emphasis:
 * one not flanked by a word character on BOTH sides. `before` and `after` are
 * the characters the serializer knows sit outside this node — the same context
 * `safe()` itself is handed — so a `_` at either edge is judged against its
 * real neighbour rather than against the node boundary.
 */
export function escapeDelimiterUnderscores(
  written: string,
  before: string | undefined,
  after: string | undefined,
): string {
  if (!written.includes('_')) return written;
  let out = '';
  for (let i = 0; i < written.length; i += 1) {
    const character = written[i];
    if (character === '_' && !alreadyEscaped(written, i)) {
      const left = i > 0 ? written[i - 1] : before?.slice(-1) || undefined;
      const right = i + 1 < written.length ? written[i + 1] : after?.charAt(0) || undefined;
      const intraword = isWordCharacter(left) && isWordCharacter(right);
      if (!intraword) out += '\\';
    }
    out += character;
  }
  return out;
}

/**
 * Whether the character at `index` already carries a backslash of its own: an
 * odd run of backslashes before it. `safe()` still escapes a `_` that starts a
 * line (the thematic-break rule stays in the list), and a literal backslash in
 * the note comes out as `\\` — even, so the `_` after it is unescaped.
 */
function alreadyEscaped(written: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && written[i] === '\\'; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

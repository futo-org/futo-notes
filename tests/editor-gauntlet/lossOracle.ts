/**
 * "Did any writing disappear?" — the only preservation question a WYSIWYG
 * candidate can be held to.
 *
 * ADR-0002 accepts that a round-trip through a rich-text editor rewrites
 * markdown syntax (bullet style, emphasis markers, escaping, table padding),
 * so the gauntlet's byte-diff assertions stop being a pass/fail signal for such
 * a candidate and become reported evidence. What still has to hold is the bar
 * the corpus census used: never refuse the edit, never warn, and never LOSE
 * text. This module is the "never lose" half.
 *
 * The oracle is a token multiset containment check. Every token the note had
 * before must still be there afterwards; anything the editor ADDS is not loss
 * (the census's spurious-`<br />` class is corruption, tracked separately).
 *
 * Tokenizing rules, in order, and why each one exists:
 *
 * 1. Per line, drop a leading block marker — blockquote `>`, ATX `#`, bullet
 *    `-`/`*`/`+`, ordered `1.`/`1)`. Serializers legitimately rewrite all of
 *    these, and an ordered list may be renumbered.
 * 2. Undo backslash escapes. CommonMark escaping (`\[\[wikilink]]`, LaTeX `_`)
 *    changes bytes and changes nothing a reader sees.
 * 3. Split on whitespace. Whitespace normalization — table cell padding, a
 *    newline inside an inline code span becoming a space — is not loss.
 * 4. Split HTML tags out as their own tokens, so a deleted `<br>` reports the
 *    words that fused rather than one unrecognizable blob.
 * 5. Strip inline syntax characters from each token's EDGES only, never its
 *    middle. Edge-only is what makes the `<br>` word-fusion bug visible:
 *    `one.<br>two.` tokenizes to `one.`/`br`/`two.` while the fused
 *    `one.two.` is a single token none of them match.
 * 6. Drop tokens with no letter and no digit — a lone `|`, `---`, or `:-:`.
 *
 * Known blind spots, deliberately: it cannot see reordering, structural
 * corruption that keeps every word, or a word that moved into the wrong block.
 * Those stay as the sweep's reported rewrite metrics.
 */

/** Characters a serializer may add or remove at a token boundary. */
const EDGE_SYNTAX = '*_~`#>|[](){}<>!';

/** A leading block marker: blockquotes, ATX heading, bullet or ordered item. */
const LEADING_BLOCK_MARKER = /^(?:\s*(?:>+|#{1,6}|[-*+]|\d+[.)]))+\s*/;

/**
 * An HTML tag, split out as its own token. Without this a deleted inline
 * `<br>` hides inside the fused token `one.<br>sentence`, and the report names
 * that instead of the two words a reader actually lost.
 */
const HTML_TAG = /(<\/?[A-Za-z][^<>\s]*\s*\/?>)/g;

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** ASCII-punctuation backslash escapes, the only ones CommonMark defines. */
const BACKSLASH_ESCAPE = /\\([!-/:-@[-`{-~])/g;

function stripEdges(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && EDGE_SYNTAX.includes(token[start]!)) start += 1;
  while (end > start && EDGE_SYNTAX.includes(token[end - 1]!)) end -= 1;
  return token.slice(start, end);
}

/** The reader-visible tokens of a markdown source, in document order. */
export function textTokens(source: string): string[] {
  const tokens: string[] = [];
  for (const rawLine of source.split('\n')) {
    const line = rawLine
      .replace(LEADING_BLOCK_MARKER, '')
      .replace(BACKSLASH_ESCAPE, '$1')
      .replace(HTML_TAG, ' $1 ');
    for (const rawToken of line.split(/\s+/)) {
      if (!rawToken) continue;
      const token = stripEdges(rawToken);
      if (token && HAS_LETTER_OR_DIGIT.test(token)) tokens.push(token);
    }
  }
  return tokens;
}

export interface TextLossReport {
  /** Distinct tokens that lost at least one copy, in first-seen order. */
  lostTokens: string[];
  /** Total copies lost across every token. */
  lostTokenCount: number;
}

export interface TextLossOptions {
  /**
   * A single character the comparison is allowed to see inserted into ONE
   * token. The foreign sweep types exactly one character into each block, and
   * a rich editor puts it inside the block's text (`- xitem`) where the source
   * offset would have put it before the marker (`x- item`) — same edit, and not
   * a reason to call the block lost.
   */
  absorbable?: string;
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/** Every way `absorbable` could be inserted into `token`, longest first. */
function absorptions(token: string, absorbable: string): string[] {
  const candidates: string[] = [];
  for (let index = 0; index <= token.length; index += 1) {
    candidates.push(token.slice(0, index) + absorbable + token.slice(index));
  }
  return candidates;
}

/** Tokens present in `before` that no longer have a matching copy in `after`. */
export function detectTextLoss(
  before: string,
  after: string,
  options: TextLossOptions = {},
): TextLossReport {
  if (options.absorbable !== undefined && options.absorbable.length !== 1) {
    throw new Error('detectTextLoss: absorbable must be exactly one character');
  }
  const remaining = countTokens(textTokens(after));
  const lostTokens: string[] = [];
  let lostTokenCount = 0;
  let absorbable = options.absorbable;

  for (const token of textTokens(before)) {
    const available = remaining.get(token) ?? 0;
    if (available > 0) {
      remaining.set(token, available - 1);
      continue;
    }
    // The one inserted character may be sitting inside a surviving token.
    const absorbed = absorbable
      ? absorptions(token, absorbable).find((candidate) => (remaining.get(candidate) ?? 0) > 0)
      : undefined;
    if (absorbed) {
      remaining.set(absorbed, remaining.get(absorbed)! - 1);
      absorbable = undefined;
      continue;
    }
    lostTokenCount += 1;
    if (!lostTokens.includes(token)) lostTokens.push(token);
  }

  return { lostTokens, lostTokenCount };
}

/**
 * How many distinct lost words a report keeps as evidence. Enough to recognise
 * a pattern, small enough that a corpus-wide run stays readable.
 */
export const LOST_TOKEN_SAMPLE_LIMIT = 50;

/** Adds `tokens` to `samples` in place, de-duplicated and capped. */
export function collectLostTokenSamples(samples: string[], tokens: readonly string[]): void {
  for (const token of tokens) {
    if (samples.length >= LOST_TOKEN_SAMPLE_LIMIT) return;
    if (!samples.includes(token)) samples.push(token);
  }
}

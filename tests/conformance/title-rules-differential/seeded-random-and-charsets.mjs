/**
 * Deterministic randomness and the adversarial character sets the corpora share.
 */

// --- Deterministic randomness ----------------------------------------------
//
// xorshift32 with a per-corpus fixed seed: reproducibility, while still sampling
// combination spaces too large to hand-author. A failure always replays from the
// printed input.

export function xorshift32(seed) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

/** Deterministic string of `length` picks from `alphabet`. */
export function sample(rng, alphabet, length) {
  let out = '';
  for (let index = 0; index < length; index += 1) out += alphabet[rng() % alphabet.length];
  return out;
}

/** Order-preserving de-duplication. */
export function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// --- Shared adversarial character sets --------------------------------------

// Whitespace-ish code points, chosen where the two languages' notions of "space"
// are most likely to part company: JS `/\s/` + `String.prototype.trim` versus
// Rust's `char::is_whitespace()` (Unicode White_Space) + the regex crate's `\s`.
// U+0085 is White_Space but NOT JS `\s`; U+FEFF is JS `\s` but NOT White_Space;
// U+200B is neither, and is in the list to prove it stays neither.
export const WHITESPACE_ISH = [
  ' ', // U+0020 space
  '\t',
  '\n',
  '\r',
  '\r\n',
  '\v', // U+000B line tabulation
  '\f', // U+000C form feed
  '\u0085', // NEL - White_Space, NOT JS \s
  '\u00a0', // no-break space
  '\u1680', // ogham space mark
  '\u2000', // en quad
  '\u2003', // em space
  '\u2007', // figure space
  '\u200a', // hair space
  '\u2028', // line separator
  '\u2029', // paragraph separator
  '\u202f', // narrow no-break space
  '\u205f', // medium mathematical space
  '\u3000', // ideographic space
  '\u200b', // ZWSP - neither language calls it space
  '\ufeff', // BOM/ZWNBSP - JS \s, NOT White_Space
];

// Characters whose case mapping is not a simple ASCII flip: final sigma
// (context-dependent), sharp s (length-changing), dotted/dotless I, the Kelvin
// sign, a ligature, long s. Case folding drives sibling collisions, the
// Windows-reserved check, tag normalization, and image-extension matching.
export const CASE_TRAPS = [
  'Straße',
  'STRASSE',
  'ß',
  'SS',
  'İstanbul',
  'istanbul',
  'ı',
  'I',
  'ΟΔΟΣ',
  'οδος',
  'ΑΣ',
  'ας',
  'ς',
  'σ',
  'K', // Kelvin sign
  'k',
  'ﬁ', // fi ligature
  'fi',
  'ſ', // long s
  's',
];

// Astral (surrogate-pair) and combining sequences: where "one character" means
// different things to `String.length`, `Array.from`, and Rust's `chars()`. Lone
// surrogates are deliberately absent - a Rust `&str` cannot hold one, so there is
// no answer to compare.
export const PARTY = '\u{1f389}';
export const FAMILY = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}';
export const ASTRAL = [
  PARTY,
  FAMILY,
  '\u{1f1fa}\u{1f1f8}', // regional-indicator pair
  'é', // precomposed e-acute
  'e\u0301', // decomposed e-acute
  '\u{1f44d}\u{1f3ff}', // emoji + skin-tone modifier
];

// \u0000 here is the LOW BOUND of the ASCII range, not a stray control
// character: the test is "is every code point in 0x00-0x7f".
// eslint-disable-next-line no-control-regex
export const isAscii = (value) => typeof value === 'string' && !/[^\u0000-\u007f]/u.test(value);

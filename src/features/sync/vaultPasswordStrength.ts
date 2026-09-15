/**
 * The strength estimate shown while a person chooses a vault password.
 *
 * Length is the only *rule* — Rust owns the 12-character minimum and there are
 * no composition rules (ADR 0003, decision 7). This is advice on top of it.
 *
 * Deliberately a small local estimate rather than a password-strength library:
 * zxcvbn and its ports carry a multi-hundred-kilobyte dictionary, and this is
 * the only screen in the app that would ever ask. What it has to get right is
 * narrow — reward variety and length, refuse to call a repeated character
 * strong — and that is checkable, which `vaultPasswordStrength.test.ts` does.
 */

export type VaultPasswordStrength = 'tooShort' | 'weak' | 'fair' | 'strong';

/** Size of each character pool a password draws from. */
const POOLS: ReadonlyArray<readonly [RegExp, number]> = [
  [/[a-z]/, 26],
  [/[A-Z]/, 26],
  [/[0-9]/, 10],
  [/[^a-zA-Z0-9]/, 33],
];

const FAIR_BITS = 45;
const STRONG_BITS = 70;

export function vaultPasswordStrength(
  password: string,
  minimumLength: number,
): VaultPasswordStrength {
  const characters = [...password];
  if (characters.length < minimumLength) return 'tooShort';

  const bits = estimatedBits(characters);
  if (bits >= STRONG_BITS) return 'strong';
  if (bits >= FAIR_BITS) return 'fair';
  return 'weak';
}

/**
 * Roughly how much guessing this password costs: its length against the pools
 * it draws from, with length capped at twice the number of distinct
 * characters. That cap is what stops sixteen identical letters — long enough
 * to pass the minimum — from being reported as anything but weak, while
 * leaving an ordinary password's length untouched.
 */
function estimatedBits(characters: string[]): number {
  const pool = POOLS.reduce(
    (total, [pattern, size]) => (characters.some((c) => pattern.test(c)) ? total + size : total),
    0,
  );
  if (pool === 0) return 0;
  const distinct = new Set(characters).size;
  const effectiveLength = Math.min(characters.length, distinct * 2);
  return effectiveLength * Math.log2(pool);
}

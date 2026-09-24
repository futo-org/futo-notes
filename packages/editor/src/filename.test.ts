import { describe, it, expect } from 'vitest';
import { sanitizeTitle, FORBIDDEN_CHARS_RE } from './filename';

// Input/output cases for every filename rule live in the hand-reviewed golden
// tests/conformance/filename.json (run by conformance.test.ts and the Rust
// model crate). This file keeps only what that op-dispatched golden cannot
// express.

describe('sanitizeTitle', () => {
  it('is a fixed point: sanitizing its own output changes nothing', () => {
    const sanitized = sanitizeTitle('  . a. . .  ');
    expect(sanitizeTitle(sanitized)).toBe(sanitized);
  });
});

describe('FORBIDDEN_CHARS_RE', () => {
  it('matches all expected characters', () => {
    const forbidden = '<>:"/\\|?*\x00\x1f\x7f';
    for (const char of forbidden) {
      FORBIDDEN_CHARS_RE.lastIndex = 0;
      expect(FORBIDDEN_CHARS_RE.test(char)).toBe(true);
    }
  });

  it('does not match normal characters', () => {
    FORBIDDEN_CHARS_RE.lastIndex = 0;
    expect(FORBIDDEN_CHARS_RE.test('abc')).toBe(false);
  });
});

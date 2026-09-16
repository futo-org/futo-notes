import { describe, expect, it } from 'vitest';

import { formatCountdown, secondsUntil } from './pairingCountdown';

const NOW = Date.parse('2026-09-15T12:00:00.000Z');

describe('how long a pairing code has left', () => {
  it('counts the relay window down from its own expiry', () => {
    expect(secondsUntil('2026-09-15T12:05:00.000Z', NOW)).toBe(300);
    expect(secondsUntil('2026-09-15T12:00:42.000Z', NOW)).toBe(42);
  });

  it('never goes negative, so a code that is already spent reads as spent', () => {
    expect(secondsUntil('2026-09-15T11:59:00.000Z', NOW)).toBe(0);
  });

  it('reads an unparseable timestamp as no time left rather than as forever', () => {
    expect(secondsUntil('whenever', NOW)).toBe(0);
  });

  it('formats as minutes and seconds', () => {
    expect(formatCountdown(300)).toBe('5:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(0)).toBe('0:00');
  });
});

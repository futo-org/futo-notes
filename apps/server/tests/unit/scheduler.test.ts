import { describe, it, expect } from 'vitest';
import { isWithinIdleWindow } from '../../src/search/scheduler.js';

describe('isWithinIdleWindow', () => {
  it('returns true when within same-day window', () => {
    // Window: 02:00-06:00, time: 03:30
    const now = new Date('2025-01-15T03:30:00');
    expect(isWithinIdleWindow('02:00', '06:00', now)).toBe(true);
  });

  it('returns false when before same-day window', () => {
    // Window: 02:00-06:00, time: 01:30
    const now = new Date('2025-01-15T01:30:00');
    expect(isWithinIdleWindow('02:00', '06:00', now)).toBe(false);
  });

  it('returns false when after same-day window', () => {
    // Window: 02:00-06:00, time: 07:00
    const now = new Date('2025-01-15T07:00:00');
    expect(isWithinIdleWindow('02:00', '06:00', now)).toBe(false);
  });

  it('returns true at exact start of window', () => {
    const now = new Date('2025-01-15T02:00:00');
    expect(isWithinIdleWindow('02:00', '06:00', now)).toBe(true);
  });

  it('returns false at exact end of window', () => {
    const now = new Date('2025-01-15T06:00:00');
    expect(isWithinIdleWindow('02:00', '06:00', now)).toBe(false);
  });

  it('handles midnight-spanning window (before midnight)', () => {
    // Window: 23:00-06:00, time: 23:30
    const now = new Date('2025-01-15T23:30:00');
    expect(isWithinIdleWindow('23:00', '06:00', now)).toBe(true);
  });

  it('handles midnight-spanning window (after midnight)', () => {
    // Window: 23:00-06:00, time: 03:00
    const now = new Date('2025-01-15T03:00:00');
    expect(isWithinIdleWindow('23:00', '06:00', now)).toBe(true);
  });

  it('handles midnight-spanning window (outside, afternoon)', () => {
    // Window: 23:00-06:00, time: 15:00
    const now = new Date('2025-01-15T15:00:00');
    expect(isWithinIdleWindow('23:00', '06:00', now)).toBe(false);
  });

  it('handles midnight-spanning window (outside, morning)', () => {
    // Window: 23:00-06:00, time: 08:00
    const now = new Date('2025-01-15T08:00:00');
    expect(isWithinIdleWindow('23:00', '06:00', now)).toBe(false);
  });
});

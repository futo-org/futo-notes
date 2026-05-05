import { describe, expect, it } from 'vitest';
import { shouldPreventScrollChaining } from './touchScrollContain';

describe('shouldPreventScrollChaining', () => {
  it('prevents chaining when the target cannot scroll', () => {
    expect(shouldPreventScrollChaining({ scrollTop: 0, clientHeight: 80, scrollHeight: 80 }, -20)).toBe(true);
    expect(shouldPreventScrollChaining({ scrollTop: 0, clientHeight: 80, scrollHeight: 80 }, 20)).toBe(true);
  });

  it('prevents chaining at the top when dragging downward', () => {
    expect(shouldPreventScrollChaining({ scrollTop: 0, clientHeight: 80, scrollHeight: 200 }, 20)).toBe(true);
  });

  it('prevents chaining at the bottom when dragging upward', () => {
    expect(shouldPreventScrollChaining({ scrollTop: 120, clientHeight: 80, scrollHeight: 200 }, -20)).toBe(true);
  });

  it('allows scrolling while there is room in the drag direction', () => {
    expect(shouldPreventScrollChaining({ scrollTop: 50, clientHeight: 80, scrollHeight: 200 }, 20)).toBe(false);
    expect(shouldPreventScrollChaining({ scrollTop: 50, clientHeight: 80, scrollHeight: 200 }, -20)).toBe(false);
  });
});

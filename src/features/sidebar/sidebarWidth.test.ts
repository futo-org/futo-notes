import { describe, expect, it } from 'vitest';

import { clampSidebarWidth, MIN_SIDEBAR_WIDTH } from './sidebarWidth';

describe('clampSidebarWidth', () => {
  it('keeps the sidebar wide enough for the full brand', () => {
    expect(clampSidebarWidth(200)).toBe(MIN_SIDEBAR_WIDTH);
    expect(MIN_SIDEBAR_WIDTH).toBe(240);
  });

  it('preserves widths within the supported range', () => {
    expect(clampSidebarWidth(320)).toBe(320);
  });

  it('caps oversized widths', () => {
    expect(clampSidebarWidth(700)).toBe(600);
  });
});

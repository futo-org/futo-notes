import { expect, it } from 'vitest';

import { clampSidebarWidth } from './sidebarWidth';

// 240 keeps the sidebar wide enough for the full brand; 600 caps oversized widths.
it.each([
  [200, 240],
  [320, 320],
  [700, 600],
])('clampSidebarWidth(%i) is %i', (width, expected) => {
  expect(clampSidebarWidth(width)).toBe(expected);
});

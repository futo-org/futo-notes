import { describe, expect, it } from 'vitest';

import { resolveBlockContainment } from './blockContainment';

describe('resolveBlockContainment', () => {
  it('skips offscreen blocks on Chromium — the engine the perf budgets were measured on', () => {
    expect(resolveBlockContainment(false)).toBe('offscreen-skipped');
  });

  it('renders every block eagerly on Apple WebKit, which paints holes instead', () => {
    expect(resolveBlockContainment(true)).toBe('eager');
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

function withSearch<T>(search: string, run: () => T): T {
  const original = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...original, search },
  });
  try {
    return run();
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  }
}

describe('resolveBlockDragMode', () => {
  // jsdom's UA is neither iOS nor Android: the host flag is the whole gate,
  // which is exactly the point — both native shells get the same gesture. A
  // test may force either mode from the query string; an unrecognised forced
  // value is ignored rather than obeyed.
  it.each([
    [true, '', 'long-press'],
    [false, '', 'gutter-handle'],
    [true, '?blockDragMode=gutter-handle', 'gutter-handle'],
    [false, '?blockDragMode=long-press', 'long-press'],
    [true, '?blockDragMode=nonsense', 'long-press'],
    [false, '?blockDragMode=nonsense', 'gutter-handle'],
  ])('native shell %s with search %j uses %s', async (nativeShell, search, expected) => {
    const { resolveBlockDragMode } = await import('./blockDragMode');
    expect(withSearch(search, () => resolveBlockDragMode(nativeShell))).toBe(expected);
  });
});

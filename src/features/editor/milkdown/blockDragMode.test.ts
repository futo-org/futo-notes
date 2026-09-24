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
  it('long-presses in a native shell, whatever the user agent says', async () => {
    // jsdom's UA is neither iOS nor Android: the host flag is the whole gate,
    // which is exactly the point — both native shells get the same gesture.
    const { resolveBlockDragMode } = await import('./blockDragMode');
    expect(resolveBlockDragMode(true)).toBe('long-press');
  });

  it('uses the gutter handle in the web app', async () => {
    const { resolveBlockDragMode } = await import('./blockDragMode');
    expect(resolveBlockDragMode(false)).toBe('gutter-handle');
  });

  it('lets a test force either mode from the query string', async () => {
    const { resolveBlockDragMode } = await import('./blockDragMode');
    expect(withSearch('?blockDragMode=gutter-handle', () => resolveBlockDragMode(true))).toBe(
      'gutter-handle',
    );
    expect(withSearch('?blockDragMode=long-press', () => resolveBlockDragMode(false))).toBe(
      'long-press',
    );
  });

  it('ignores an unrecognised forced value rather than obeying it', async () => {
    const { resolveBlockDragMode } = await import('./blockDragMode');
    expect(withSearch('?blockDragMode=nonsense', () => resolveBlockDragMode(true))).toBe(
      'long-press',
    );
    expect(withSearch('?blockDragMode=nonsense', () => resolveBlockDragMode(false))).toBe(
      'gutter-handle',
    );
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

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

afterEach(() => {
  delete (window as unknown as { __futoBlockDragMode?: string }).__futoBlockDragMode;
});

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

  it('lets a test force either mode from the window flag', async () => {
    const { resolveBlockDragMode } = await import('./blockDragMode');
    const w = window as unknown as { __futoBlockDragMode?: string };
    w.__futoBlockDragMode = 'gutter-handle';
    expect(resolveBlockDragMode(true)).toBe('gutter-handle');
    w.__futoBlockDragMode = 'long-press';
    expect(resolveBlockDragMode(false)).toBe('long-press');
  });

  it('ignores an unrecognised forced value rather than obeying it', async () => {
    const { resolveBlockDragMode } = await import('./blockDragMode');
    (window as unknown as { __futoBlockDragMode?: string }).__futoBlockDragMode = 'nonsense';
    expect(resolveBlockDragMode(true)).toBe('long-press');
    expect(resolveBlockDragMode(false)).toBe('gutter-handle');
  });
});

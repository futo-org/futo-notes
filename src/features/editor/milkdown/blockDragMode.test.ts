// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// `isIOS` is a module-level const derived from the user agent, so the platform
// module is mocked per case rather than the UA being rewritten.
vi.mock('$lib/platform', () => ({ isIOS: false }));

async function resolveWith(options: {
  isIOS: boolean;
  search?: string;
  windowFlag?: boolean;
}): Promise<string> {
  vi.resetModules();
  vi.doMock('$lib/platform', () => ({ isIOS: options.isIOS }));
  const original = window.location.search;
  if (options.search !== undefined) {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, search: options.search },
    });
  }
  if (options.windowFlag) {
    (window as unknown as { __futoForceMobileDnd?: boolean }).__futoForceMobileDnd = true;
  }
  const { resolveBlockDragMode } = await import('./blockDragMode');
  const mode = resolveBlockDragMode(true);
  if (options.search !== undefined) {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, search: original },
    });
  }
  return mode;
}

afterEach(() => {
  delete (window as unknown as { __futoForceMobileDnd?: boolean }).__futoForceMobileDnd;
  vi.doUnmock('$lib/platform');
});

describe('resolveBlockDragMode', () => {
  it('long-presses in the native iOS shell', async () => {
    expect(await resolveWith({ isIOS: true })).toBe('long-press');
  });

  it('uses the gutter handle everywhere else', async () => {
    expect(await resolveWith({ isIOS: false })).toBe('gutter-handle');
  });

  it('uses the gutter handle in the web app even on iOS', async () => {
    vi.resetModules();
    vi.doMock('$lib/platform', () => ({ isIOS: true }));
    const { resolveBlockDragMode } = await import('./blockDragMode');
    // nativeShell = false: the browser build never long-presses.
    expect(resolveBlockDragMode(false)).toBe('gutter-handle');
  });

  it('lets a test force the long-press path without an iOS device', async () => {
    expect(await resolveWith({ isIOS: false, search: '?forceMobileDnd' })).toBe('long-press');
    expect(await resolveWith({ isIOS: false, windowFlag: true })).toBe('long-press');
  });
});

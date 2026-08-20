// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveTheme, applyThemePreference, applyResolvedTheme } from './theme';
import { setNativeWindowAppearance } from '$lib/platform';

vi.mock('$lib/platform', () => ({
  setNativeWindowAppearance: vi.fn(),
}));

const nativeAppearance = vi.mocked(setNativeWindowAppearance);

afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
  nativeAppearance.mockClear();
});

describe('resolveTheme', () => {
  it('returns dark for dark preference', () => {
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('returns light for light preference', () => {
    expect(resolveTheme('light')).toBe('light');
  });

  it('returns a value for auto preference', () => {
    expect(['dark', 'light']).toContain(resolveTheme('auto'));
  });
});

describe('applyResolvedTheme', () => {
  it('sets data-theme and colorScheme on the document element', () => {
    applyResolvedTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });
});

describe('applyThemePreference', () => {
  it('uses systemThemeOverride when preference is auto', async () => {
    const result = await applyThemePreference('auto', 'dark');
    expect(result).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('ignores systemThemeOverride when preference is explicit', async () => {
    const result = await applyThemePreference('light', 'dark');
    expect(result).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('falls back to resolveTheme when no override provided', async () => {
    const result = await applyThemePreference('auto');
    expect(['dark', 'light']).toContain(result);
  });
});

describe('applyThemePreference — native window appearance', () => {
  // The window frame is drawn by the OS, in the window's appearance rather
  // than ours. On macOS AppKit strokes a highlight along the top edge whose
  // brightness is picked for that appearance, so a light-appearance window
  // showing our dark theme gets the LIGHT stroke: measured white@55% over the
  // #171717 top band (rgb 150,150,150) — a bright hairline against a dark
  // desktop — where a dark-appearance window gets white@20% (rgb 66,66,66),
  // the same subtle edge every native dark app has. An explicit preference
  // therefore has to reach the window, not just the DOM.
  it('pushes an explicit dark preference down to the native window', async () => {
    await applyThemePreference('dark');
    expect(nativeAppearance).toHaveBeenCalledWith('dark');
  });

  it('pushes an explicit light preference down to the native window', async () => {
    await applyThemePreference('light');
    expect(nativeAppearance).toHaveBeenCalledWith('light');
  });

  // `auto` must leave the window following the OS. Pinning it would silence the
  // system-appearance change `auto` exists to follow: tao decides whether to
  // emit ThemeChanged by re-reading NSApp.effectiveAppearance, which a pin
  // freezes. The resolved theme already equals the system appearance here, so
  // there is nothing to correct anyway.
  it('leaves the native window following the OS on auto', async () => {
    await applyThemePreference('auto', 'dark');
    expect(nativeAppearance).toHaveBeenCalledWith(null);
  });
});

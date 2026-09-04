// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  resolveTheme,
  resolveAutoTheme,
  applyThemePreference,
  applyResolvedTheme,
  windowAppearanceFor,
} from './theme';
import { readDesktopColorScheme, setNativeWindowAppearance } from '$lib/platform';

// `isLinux` is a live binding read at call time, so a getter lets one suite
// exercise both platform branches without reloading the module.
const platform = vi.hoisted(() => ({ isLinux: false }));

vi.mock('$lib/platform', () => ({
  setNativeWindowAppearance: vi.fn(),
  readDesktopColorScheme: vi.fn(async () => null),
  get isLinux() {
    return platform.isLinux;
  },
}));

const nativeAppearance = vi.mocked(setNativeWindowAppearance);
const desktopColorScheme = vi.mocked(readDesktopColorScheme);

afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
  nativeAppearance.mockClear();
  desktopColorScheme.mockReset();
  desktopColorScheme.mockResolvedValue(null);
  platform.isLinux = false;
  vi.unstubAllGlobals();
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

// GTK is not macOS/Windows: tao's Linux `set_theme` maps BOTH `None` and
// `Some(Light)` onto `gtk-application-prefer-dark-theme = false`, so `null` does
// not mean "follow the desktop" there — it means "prefer light". WebKitGTK then
// derives the page's own `prefers-color-scheme` from that same GTK property, so
// handing the window back to the OS overwrites the signal `resolveTheme('auto')`
// reads. Measured on Fedora 44 / WebKitGTK 2.52.5 against a dark GTK desktop:
// this app rendered LIGHT (data-theme=light, prefers-color-scheme=false) where
// the pre-change build rendered dark.
describe('windowAppearanceFor', () => {
  it('pins an explicit preference on every platform', () => {
    expect(windowAppearanceFor('dark', 'dark', false)).toBe('dark');
    expect(windowAppearanceFor('light', 'light', false)).toBe('light');
    expect(windowAppearanceFor('dark', 'dark', true)).toBe('dark');
    expect(windowAppearanceFor('light', 'light', true)).toBe('light');
  });

  it('hands the window back to the OS on auto where null means "follow the system"', () => {
    expect(windowAppearanceFor('auto', 'dark', false)).toBeNull();
    expect(windowAppearanceFor('auto', 'light', false)).toBeNull();
  });

  it('sends the resolved theme on auto on Linux, where null would force light', () => {
    expect(windowAppearanceFor('auto', 'dark', true)).toBe('dark');
    expect(windowAppearanceFor('auto', 'light', true)).toBe('light');
  });
});

// The user-visible bug this suite locks down: on a DARK Linux desktop, choosing
// Light and then Auto left the app light.
//
// Linux `auto` has to pin the window (see windowAppearanceFor above), and any
// pin writes `gtk-application-prefer-dark-theme` — the very property WebKitGTK
// answers the page's own `prefers-color-scheme` from. So an explicit choice
// poisons the signal a later `auto` reads back: measured on a dark GTK desktop,
// `setTheme('light')` makes the webview report `prefers-color-scheme: dark` as
// false. jsdom's matchMedia reports exactly that (matches: false), so it stands
// in for the poisoned reading here.
//
// The desktop's own answer lives in the xdg portal's
// `org.freedesktop.appearance` / `color-scheme`, which nothing this app does can
// overwrite — so on Linux that is what `auto` resolves from.

/** What WebKitGTK answers `prefers-color-scheme` with, i.e. the pinned value. */
function stubPageColorScheme(dark: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('dark') ? dark : !dark,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe('resolveAutoTheme', () => {
  it('prefers the desktop portal over the poisoned page media query on Linux', async () => {
    // The page reports "not dark" because Light pinned the window a moment ago,
    // while the desktop it claims to describe is dark.
    stubPageColorScheme(false);
    desktopColorScheme.mockResolvedValue('dark');

    await expect(resolveAutoTheme(undefined, true)).resolves.toBe('dark');
  });

  it('follows the page media query on Linux when the portal agrees with it', async () => {
    stubPageColorScheme(true);
    desktopColorScheme.mockResolvedValue('dark');

    await expect(resolveAutoTheme(undefined, true)).resolves.toBe('dark');
  });

  it('falls back to the reported change when the portal cannot be read', async () => {
    desktopColorScheme.mockResolvedValue(null);
    await expect(resolveAutoTheme('dark', true)).resolves.toBe('dark');
  });

  it('falls back to the page media query when Linux offers neither', async () => {
    desktopColorScheme.mockResolvedValue(null);
    await expect(resolveAutoTheme(undefined, true)).resolves.toBe('light');
  });

  // macOS and Windows hand the window back to the OS on `auto` and so never
  // write the appearance they read — their media query is trustworthy, and
  // reaching for a Linux portal there would be a regression, not a fix.
  it('never asks the desktop portal off Linux', async () => {
    desktopColorScheme.mockResolvedValue('dark');

    await expect(resolveAutoTheme(undefined, false)).resolves.toBe('light');
    await expect(resolveAutoTheme('dark', false)).resolves.toBe('dark');

    expect(desktopColorScheme).not.toHaveBeenCalled();
  });
});

describe('applyThemePreference — Linux auto', () => {
  it('renders and pins the desktop theme after an explicit choice poisoned the page', async () => {
    platform.isLinux = true;
    desktopColorScheme.mockResolvedValue('dark');
    // Choosing Light pins the window, tao writes
    // gtk-application-prefer-dark-theme=false, and the page starts answering
    // "not dark" — on a desktop that is dark.
    stubPageColorScheme(false);

    await applyThemePreference('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    await applyThemePreference('auto');

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(nativeAppearance).toHaveBeenLastCalledWith('dark');
  });

  it('does not consult the desktop portal off Linux', async () => {
    await applyThemePreference('auto');
    expect(desktopColorScheme).not.toHaveBeenCalled();
  });
});

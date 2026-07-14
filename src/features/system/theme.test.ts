// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { resolveTheme, applyThemePreference, applyResolvedTheme } from './theme';

afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
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

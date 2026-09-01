// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ readLinuxDesktopSettings: vi.fn() }));

vi.mock('$lib/platform', () => ({
  readLinuxDesktopSettings: platform.readLinuxDesktopSettings,
}));

import { applyInterfaceFontPreference, applyLinuxInterfaceFont } from './interfaceFont';

beforeEach(() => platform.readLinuxDesktopSettings.mockReset());

afterEach(() => {
  applyInterfaceFontPreference('barlow');
  document.documentElement.removeAttribute('style');
});

describe('Linux interface font', () => {
  it('uses the GTK system family on GNOME-like desktops', () => {
    applyLinuxInterfaceFont('systemUi');

    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe(
      'system-ui, sans-serif',
    );
    expect(document.documentElement.style.getPropertyValue('--font-serif')).toBe(
      'system-ui, sans-serif',
    );
  });

  it('uses the Fontconfig desktop family on Plasma', () => {
    applyLinuxInterfaceFont('sansSerif');

    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('sans-serif');
    expect(document.documentElement.style.getPropertyValue('--font-serif')).toBe('sans-serif');
  });

  it('loads the portal-selected generic family for the System preference', async () => {
    platform.readLinuxDesktopSettings.mockResolvedValue({
      theme: 'light',
      accent: null,
      interfaceFont: 'sansSerif',
    });

    applyInterfaceFontPreference('system');

    await vi.waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('sans-serif');
    });
  });

  it('restores Barlow tokens when the preference changes back', () => {
    applyLinuxInterfaceFont('systemUi');

    applyInterfaceFontPreference('barlow');

    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--font-serif')).toBe('');
  });
});

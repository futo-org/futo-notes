// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({
  accentHandler: null as ((accent: { r: number; g: number; b: number } | null) => void) | null,
  readLinuxDesktopSettings: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('$lib/platform', () => ({
  onLinuxAccentChanged: (handler: typeof platform.accentHandler) => {
    platform.accentHandler = handler;
    return platform.stop;
  },
  readLinuxDesktopSettings: platform.readLinuxDesktopSettings,
}));

import { applySystemAccent, applySystemAccentPreference, watchSystemAccentTauri } from './accent';

const root = document.documentElement;

beforeEach(() => {
  platform.accentHandler = null;
  platform.readLinuxDesktopSettings.mockReset();
  platform.stop.mockReset();
  applySystemAccentPreference(false, vi.fn());
});

afterEach(() => {
  root.removeAttribute('style');
});

describe('applySystemAccent', () => {
  it('maps portal channels to the primary CSS tokens', () => {
    applySystemAccent({ r: 0.25, g: 0.5, b: 0.75 });

    expect(root.style.getPropertyValue('--color-primary')).toBe('rgb(64 128 191)');
    expect(root.style.getPropertyValue('--primary-rgb')).toBe('64, 128, 191');
    expect(root.style.getPropertyValue('--color-primary-hover')).toBe(
      'color-mix(in srgb, rgb(64 128 191) 82%, var(--color-text))',
    );
    expect(root.style.getPropertyValue('--color-selection')).toBe(
      'color-mix(in srgb, rgb(64 128 191) 24%, transparent)',
    );
  });

  it('clamps malformed channels at the frontend boundary', () => {
    applySystemAccent({ r: -1, g: 0.5, b: 2 });

    expect(root.style.getPropertyValue('--color-primary')).toBe('rgb(0 128 255)');
    expect(root.style.getPropertyValue('--primary-rgb')).toBe('0, 128, 255');
  });

  it('restores the brand palette when the desktop has no preference', () => {
    applySystemAccent({ r: 0.25, g: 0.5, b: 0.75 });
    applySystemAccent(null);

    expect(root.style.getPropertyValue('--color-primary')).toBe('');
    expect(root.style.getPropertyValue('--color-primary-hover')).toBe('');
    expect(root.style.getPropertyValue('--primary-rgb')).toBe('');
    expect(root.style.getPropertyValue('--color-selection')).toBe('');
  });
});

describe('system accent preference', () => {
  it('applies the current portal accent when enabled', async () => {
    const onChange = vi.fn();
    platform.readLinuxDesktopSettings.mockResolvedValue({
      theme: 'light',
      accent: { r: 0.1, g: 0.2, b: 0.3 },
    });

    applySystemAccentPreference(true, onChange);
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ r: 0.1, g: 0.2, b: 0.3 });
    });
  });

  it('restores the brand palette and ignores later portal changes when disabled', () => {
    const onChange = vi.fn();
    const stop = watchSystemAccentTauri(onChange);

    applySystemAccentPreference(false, onChange);
    platform.accentHandler?.({ r: 0.1, g: 0.2, b: 0.3 });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(null);
    stop();
    expect(platform.stop).toHaveBeenCalledOnce();
  });
});

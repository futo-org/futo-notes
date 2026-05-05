// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

async function importPlatform(userAgent: string, tauri = true): Promise<typeof import('./index')> {
  vi.resetModules();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  if (tauri) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  } else {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  }
  return import('./index');
}

afterEach(() => {
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('soft keyboard primer', () => {
  it('focuses a hidden input on iOS Tauri during the user gesture', async () => {
    const platform = await importPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');

    platform.primeSoftKeyboardForProgrammaticFocus();

    const primer = document.querySelector('[data-futo-keyboard-primer="true"]');
    expect(primer).toBeInstanceOf(HTMLInputElement);
    expect(document.activeElement).toBe(primer);
  });

  it('does nothing outside iOS Tauri', async () => {
    const platform = await importPlatform('Mozilla/5.0 (Linux; Android 15)', true);

    platform.primeSoftKeyboardForProgrammaticFocus();

    expect(document.querySelector('[data-futo-keyboard-primer="true"]')).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The desktop chrome class is what gates every desktop-only rule in
// src/styles/desktop-native.css. If it leaked into the browser dev server or
// the native editor embed, the cursor sweep would apply to touch surfaces too.
const platform = { isTauri: true, isMac: false, isLinux: false };
vi.mock('$lib/platform', () => ({
  get isTauri() {
    return platform.isTauri;
  },
  get isMac() {
    return platform.isMac;
  },
  get isLinux() {
    return platform.isLinux;
  },
}));

const { configureWindowChrome, DESKTOP_CHROME_CLASS } = await import('./configureWindowChrome');

describe('desktop chrome class', () => {
  beforeEach(() => {
    platform.isTauri = true;
    platform.isMac = false;
    platform.isLinux = false;
  });

  afterEach(() => {
    document.documentElement.classList.remove(DESKTOP_CHROME_CLASS);
  });

  it('marks the document under Tauri and clears it on dispose', () => {
    const { dispose } = configureWindowChrome();
    expect(document.documentElement.classList.contains(DESKTOP_CHROME_CLASS)).toBe(true);
    dispose();
    expect(document.documentElement.classList.contains(DESKTOP_CHROME_CLASS)).toBe(false);
  });

  it('does not mark the document off Tauri', () => {
    platform.isTauri = false;
    configureWindowChrome();
    expect(document.documentElement.classList.contains(DESKTOP_CHROME_CLASS)).toBe(false);
  });
});

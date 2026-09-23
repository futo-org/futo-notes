// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriWindow = vi.hoisted(() => ({
  setTitle: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: tauriWindow.setTitle }),
}));

async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadPlatform() {
  Reflect.set(window, '__TAURI_INTERNALS__', {});
  return import('./index');
}

// App.svelte writes the localized app name (and re-runs on every language
// change); TabsStrip writes the active note. The native title must always be
// the composition of both, whichever wrote last.
describe('native window title', () => {
  beforeEach(() => {
    vi.resetModules();
    tauriWindow.setTitle.mockReset();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('keeps the active note in the title when the language changes', async () => {
    const platform = await loadPlatform();
    platform.setApplicationWindowTitle('FUTO Notes (Dev)');
    platform.setAppWindowTitle('welcome');
    await settle();
    expect(tauriWindow.setTitle).toHaveBeenLastCalledWith('welcome — FUTO Notes (Dev)');

    platform.setApplicationWindowTitle('FUTO 笔记（开发版）');
    await settle();

    expect(tauriWindow.setTitle).toHaveBeenLastCalledWith('welcome — FUTO 笔记（开发版）');
  });

  it('composes the note title with the localized app name', async () => {
    const platform = await loadPlatform();
    platform.setApplicationWindowTitle('FUTO 笔记');
    await settle();
    platform.setAppWindowTitle('welcome');
    await settle();

    expect(tauriWindow.setTitle).toHaveBeenLastCalledWith('welcome — FUTO 笔记');
  });

  it('falls back to the bare localized app name on Home', async () => {
    const platform = await loadPlatform();
    platform.setApplicationWindowTitle('FUTO 笔记');
    platform.setAppWindowTitle('welcome');
    await settle();
    platform.setAppWindowTitle(undefined);
    await settle();

    expect(tauriWindow.setTitle).toHaveBeenLastCalledWith('FUTO 笔记');
  });

  it('settles on the composed title when both writers fire together at startup', async () => {
    const platform = await loadPlatform();
    platform.setAppWindowTitle('welcome');
    platform.setApplicationWindowTitle('FUTO Notes (Dev)');
    await settle();

    expect(tauriWindow.setTitle).toHaveBeenLastCalledWith('welcome — FUTO Notes (Dev)');
  });
});

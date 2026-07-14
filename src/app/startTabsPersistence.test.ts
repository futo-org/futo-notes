// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllNotes: vi.fn(),
  getConfig: vi.fn(),
  hydrate: vi.fn(),
  saveConfig: vi.fn(),
  setPersister: vi.fn(),
  whenNotesReady: vi.fn(),
}));

vi.mock('$lib/platform', () => ({ hasFileSystem: true, isDesktop: true }));
vi.mock('$features/notes/notes.svelte', () => ({
  getAllNotes: mocks.getAllNotes,
  whenNotesReady: mocks.whenNotesReady,
}));
vi.mock('$features/tabs/tabsStore.svelte', () => ({
  tabsStore: {
    hydrate: mocks.hydrate,
    setPersister: mocks.setPersister,
  },
}));
vi.mock('$lib/platform/tauri', () => ({
  getConfig: mocks.getConfig,
  saveConfig: mocks.saveConfig,
}));

import { startTabsPersistence } from './startTabsPersistence';

describe('startTabsPersistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    mocks.getAllNotes.mockReturnValue([]);
    mocks.whenNotesReady.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not hydrate or install a persister after teardown', async () => {
    let resolveConfig!: (config: {
      sidebarWidth: number;
      graphSidebarWidth: number;
      openTabs: null;
    }) => void;
    mocks.getConfig.mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve;
      }),
    );
    const setSidebarCollapsed = vi.fn();
    const setSidebarWidth = vi.fn();
    const setGraphSidebarWidth = vi.fn();
    const stop = startTabsPersistence({
      initialNoteId: null,
      setSidebarCollapsed,
      setSidebarWidth,
      setGraphSidebarWidth,
    });

    stop();
    resolveConfig({ sidebarWidth: 310, graphSidebarWidth: 360, openTabs: null });
    await vi.waitFor(() => expect(mocks.getConfig).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(setSidebarWidth).not.toHaveBeenCalled();
    expect(setGraphSidebarWidth).not.toHaveBeenCalled();
    expect(mocks.hydrate).not.toHaveBeenCalled();
    expect(mocks.setPersister).toHaveBeenCalledTimes(1);
    expect(mocks.setPersister).toHaveBeenLastCalledWith(null);
  });
});

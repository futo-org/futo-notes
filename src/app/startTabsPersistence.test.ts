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

vi.mock('$lib/platform', () => ({ isTauri: true, isDesktop: true }));
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
    let resolveConfig!: (config: { sidebarWidth: number; openTabs: null }) => void;
    mocks.getConfig.mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve;
      }),
    );
    const setSidebarCollapsed = vi.fn();
    const setSidebarWidth = vi.fn();
    const stop = startTabsPersistence({
      getRequestedNoteId: () => null,
      setSidebarCollapsed,
      setSidebarWidth,
    });

    stop();
    resolveConfig({ sidebarWidth: 310, openTabs: null });
    await vi.waitFor(() => expect(mocks.getConfig).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(setSidebarWidth).not.toHaveBeenCalled();
    expect(mocks.hydrate).not.toHaveBeenCalled();
    expect(mocks.setPersister).toHaveBeenCalledTimes(1);
    expect(mocks.setPersister).toHaveBeenLastCalledWith(null);
  });

  it('hydrates the latest hash request when navigation changes while notes are loading', async () => {
    let resolveNotesReady!: () => void;
    let requestedNoteId: string | null = 'first';
    mocks.getConfig.mockResolvedValue({ sidebarWidth: 280, openTabs: null });
    mocks.whenNotesReady.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveNotesReady = resolve;
      }),
    );
    mocks.getAllNotes.mockReturnValue([{ id: 'first' }, { id: 'second' }]);

    startTabsPersistence({
      getRequestedNoteId: () => requestedNoteId,
      setSidebarCollapsed: vi.fn(),
      setSidebarWidth: vi.fn(),
    });
    await vi.waitFor(() => expect(mocks.whenNotesReady).toHaveBeenCalledOnce());

    requestedNoteId = 'second';
    resolveNotesReady();

    await vi.waitFor(() => expect(mocks.hydrate).toHaveBeenCalledOnce());
    expect(mocks.hydrate.mock.calls[0][2]).toBe('second');
  });

  it('preserves an explicit navigation to Home while notes are loading', async () => {
    let resolveNotesReady!: () => void;
    let requestedNoteId: string | null | undefined = 'first';
    mocks.getConfig.mockResolvedValue({ sidebarWidth: 280, openTabs: null });
    mocks.whenNotesReady.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveNotesReady = resolve;
      }),
    );
    mocks.getAllNotes.mockReturnValue([{ id: 'first' }]);

    startTabsPersistence({
      getRequestedNoteId: () => requestedNoteId,
      setSidebarCollapsed: vi.fn(),
      setSidebarWidth: vi.fn(),
    });
    await vi.waitFor(() => expect(mocks.whenNotesReady).toHaveBeenCalledOnce());

    requestedNoteId = null;
    resolveNotesReady();

    await vi.waitFor(() => expect(mocks.hydrate).toHaveBeenCalledOnce());
    expect(mocks.hydrate.mock.calls[0][2]).toBeNull();
  });

  it('clamps a persisted sidebar width that would wrap the brand', async () => {
    mocks.getConfig.mockResolvedValue({
      sidebarWidth: 200,
      openTabs: null,
    });
    const setSidebarWidth = vi.fn();

    startTabsPersistence({
      getRequestedNoteId: () => null,
      setSidebarCollapsed: vi.fn(),
      setSidebarWidth,
    });

    await vi.waitFor(() => expect(setSidebarWidth).toHaveBeenCalledWith(240));
  });
});

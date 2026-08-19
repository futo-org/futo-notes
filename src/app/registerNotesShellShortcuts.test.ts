// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const menuHandlers: Array<(command: string) => void> = [];

vi.mock('$lib/platform', () => ({
  onAppMenuCommand: (handler: (command: string) => void) => {
    menuHandlers.push(handler);
    return () => {
      const index = menuHandlers.indexOf(handler);
      if (index >= 0) menuHandlers.splice(index, 1);
    };
  },
}));

import { registerNotesShellShortcuts } from './registerNotesShellShortcuts';
import { tabsStore } from '$features/tabs/tabsStore.svelte';

function press(key: string, init: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

describe('registerNotesShellShortcuts', () => {
  let stop: () => void;
  let deps: {
    openSearch: ReturnType<typeof vi.fn>;
    createNote: ReturnType<typeof vi.fn>;
    openSettings: ReturnType<typeof vi.fn>;
    toggleSidebar: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    menuHandlers.length = 0;
    tabsStore.__resetForTests();
    deps = {
      openSearch: vi.fn(),
      createNote: vi.fn(),
      openSettings: vi.fn(),
      toggleSidebar: vi.fn(),
    };
    // jsdom reports a non-Mac agent, so the primary modifier is Ctrl.
    stop = registerNotesShellShortcuts(deps);
  });

  afterEach(() => stop());

  it('opens settings on the primary modifier + comma', () => {
    const event = press(',', { ctrlKey: true });
    expect(deps.openSettings).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('toggles the sidebar on the primary modifier + backslash', () => {
    const event = press('\\', { ctrlKey: true });
    expect(deps.toggleSidebar).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  // On macOS the application menu consumes these key equivalents before the
  // webview sees them, so the menu path is the ONLY path there — an unhandled
  // command id would make a menu item silently do nothing.
  it('runs the same commands when the native menu dispatches them', () => {
    expect(menuHandlers).toHaveLength(1);
    const dispatch = menuHandlers[0]!;

    dispatch('new-note');
    dispatch('search');
    dispatch('settings');
    dispatch('toggle-sidebar');

    expect(deps.createNote).toHaveBeenCalledTimes(1);
    expect(deps.openSearch).toHaveBeenCalledTimes(1);
    expect(deps.openSettings).toHaveBeenCalledTimes(1);
    expect(deps.toggleSidebar).toHaveBeenCalledTimes(1);
  });

  it('close-tab from the menu closes the tab, not the window', () => {
    tabsStore.newTab();
    const before = tabsStore.tabs.length;
    menuHandlers[0]!('close-tab');
    expect(tabsStore.tabs.length).toBe(before - 1);
  });

  it('unsubscribes from the menu on dispose', () => {
    stop();
    expect(menuHandlers).toHaveLength(0);
    stop = () => {};
  });
});

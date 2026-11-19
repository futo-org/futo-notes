// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const menuHandlers: Array<(command: string) => void> = [];
const closeAppWindow = vi.hoisted(() => vi.fn());

vi.mock('$lib/platform', () => ({
  closeAppWindow,
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
import { registeredVerbs } from './puppet/puppetRegistry';

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
    findEnabled: ReturnType<typeof vi.fn>;
    openFind: ReturnType<typeof vi.fn>;
    stepFind: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    menuHandlers.length = 0;
    tabsStore.__resetForTests();
    closeAppWindow.mockClear();
    deps = {
      openSearch: vi.fn(),
      createNote: vi.fn(),
      openSettings: vi.fn(),
      toggleSidebar: vi.fn(),
      findEnabled: vi.fn(() => true),
      openFind: vi.fn(),
      stepFind: vi.fn(),
    };
    // jsdom reports a non-Mac agent, so the primary modifier is Ctrl.
    stop = registerNotesShellShortcuts(deps);
  });

  afterEach(() => stop());

  it.each([
    [',', 'openSettings'],
    ['\\', 'toggleSidebar'],
  ] as const)('runs the primary modifier + %s accelerator', (key, dep) => {
    const event = press(key, { ctrlKey: true });
    expect(deps[dep]).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('steps back a tab on Ctrl+Shift+Tab when WebKitGTK names the key Unidentified', () => {
    const prevTab = vi.spyOn(tabsStore, 'prevTab');
    const event = press('Unidentified', { code: 'Tab', ctrlKey: true, shiftKey: true });
    expect(prevTab).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    prevTab.mockRestore();
  });

  it('closes the desktop window on Ctrl+Q so the close handler can flush saves', () => {
    const event = press('q', { ctrlKey: true });

    expect(closeAppWindow).toHaveBeenCalledTimes(1);
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

  it('claims find shortcuts without touching the editor while another surface owns input', () => {
    deps.findEnabled.mockReturnValue(false);

    expect(press('f', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press('g', { ctrlKey: true }).defaultPrevented).toBe(true);

    expect(deps.openFind).not.toHaveBeenCalled();
    expect(deps.stepFind).not.toHaveBeenCalled();
  });

  it('the tab keys are verbs: StepTab both ways, ActivateTabByNumber counting from 1 like Cmd+N', () => {
    const run = (name: string, args: Record<string, unknown>) =>
      registeredVerbs()
        .find((verb) => verb.name === name)!
        .run(args);
    tabsStore.openNote('a', 'current');
    tabsStore.openNote('b', 'foreground');
    tabsStore.openNote('c', 'foreground');

    run('ActivateTabByNumber', { number: 1 });
    expect(tabsStore.activeTab.noteId).toBe('a');
    run('StepTab', { direction: 1 });
    expect(tabsStore.activeTab.noteId).toBe('b');
    run('StepTab', { direction: -1 });
    expect(tabsStore.activeTab.noteId).toBe('a');
    run('ActivateTabByNumber', { number: 9 });
    expect(tabsStore.activeTab.noteId).toBe('c');
    expect(run('StepTab', { direction: 2 })).toMatchObject({ status: 400 });
    expect(run('ActivateTabByNumber', { number: 0 })).toMatchObject({ status: 400 });
  });

  it('unsubscribes from the menu on dispose', () => {
    stop();
    expect(menuHandlers).toHaveLength(0);
    stop = () => {};
  });
});

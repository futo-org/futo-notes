import { onAppMenuCommand } from '$lib/platform';
import { tabsStore } from '$features/tabs/tabsStore.svelte';

export interface NotesShellShortcutDeps {
  openSearch: () => void;
  createNote: () => void;
  openSettings: () => void;
  toggleSidebar: () => void;
}

function isMacAgent(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);
}

// Named shell commands. Both input sources — the keydown handler below and the
// macOS application menu (apps/tauri/src-tauri/src/app_menu.rs) — dispatch
// through this one table, so a command can never mean two different things
// depending on how it was invoked. The Rust menu's command ids are locked
// against this file by `frontend_commands_match_the_shell`.
export type ShellCommand =
  'new-note' | 'new-tab' | 'reopen-tab' | 'close-tab' | 'search' | 'settings' | 'toggle-sidebar';

function runCommand(command: ShellCommand, deps: NotesShellShortcutDeps): void {
  switch (command) {
    case 'new-note':
      deps.createNote();
      return;
    case 'new-tab':
      tabsStore.newTab();
      return;
    case 'reopen-tab':
      tabsStore.reopenLastClosed();
      return;
    case 'close-tab':
      tabsStore.closeActive();
      return;
    case 'search':
      deps.openSearch();
      return;
    case 'settings':
      deps.openSettings();
      return;
    case 'toggle-sidebar':
      deps.toggleSidebar();
      return;
  }
}

// Desktop tab + navigation accelerators (tabs.md). Ctrl+Tab cycling always uses
// the physical Ctrl key (even on macOS); the primary-modifier accelerators use
// Cmd on macOS and Ctrl elsewhere.
//
// On macOS the application menu owns most of these key equivalents and
// NSApplication resolves them before the webview ever sees the keystroke, so
// this handler is the Windows/Linux path for those combos — and the only path
// for the ones with no menu item (Ctrl+Tab, Cmd+1..9).
export function registerNotesShellShortcuts(deps: NotesShellShortcutDeps): () => void {
  function handleKeydown(event: KeyboardEvent): void {
    if (event.ctrlKey && !event.altKey && event.key === 'Tab') {
      event.preventDefault();
      if (event.shiftKey) tabsStore.prevTab();
      else tabsStore.nextTab();
      return;
    }
    if (event.ctrlKey && event.key === 'PageDown') {
      event.preventDefault();
      tabsStore.nextTab();
      return;
    }
    if (event.ctrlKey && event.key === 'PageUp') {
      event.preventDefault();
      tabsStore.prevTab();
      return;
    }
    if (isMacAgent() && event.metaKey && event.altKey) {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        tabsStore.nextTab();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        tabsStore.prevTab();
        return;
      }
    }

    const modifier = isMacAgent() ? event.metaKey : event.ctrlKey;
    if (!modifier || event.altKey) return;

    const key = event.key.toLowerCase();
    if (key === 'p') {
      event.preventDefault();
      runCommand('search', deps);
    } else if (key === 'n') {
      event.preventDefault();
      runCommand('new-note', deps);
    } else if (key === ',') {
      event.preventDefault();
      runCommand('settings', deps);
    } else if (key === '\\') {
      event.preventDefault();
      runCommand('toggle-sidebar', deps);
    } else if (key === 't' && event.shiftKey) {
      event.preventDefault();
      runCommand('reopen-tab', deps);
    } else if (key === 't') {
      event.preventDefault();
      runCommand('new-tab', deps);
    } else if (key === 'w') {
      event.preventDefault();
      runCommand('close-tab', deps);
    } else if (/^[1-9]$/.test(event.key)) {
      event.preventDefault();
      const position = Number(event.key);
      // 9 always jumps to the last tab regardless of count (tabs.md).
      if (position === 9) tabsStore.activateLast();
      else tabsStore.activateByIndex(position - 1);
    }
  }

  window.addEventListener('keydown', handleKeydown);
  const stopMenu = onAppMenuCommand((command) => runCommand(command as ShellCommand, deps));
  return () => {
    window.removeEventListener('keydown', handleKeydown);
    stopMenu();
  };
}

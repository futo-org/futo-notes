import { closeAppWindow, onAppMenuCommand } from '$lib/platform';
import { tabsStore } from '$features/tabs/tabsStore.svelte';

import {
  puppetProviders,
  puppetRefusal,
  puppetVerb,
  registerPuppetVerbs,
} from './puppet/puppetRegistry';

export interface NotesShellShortcutDeps {
  openSearch: () => void;
  createNote: () => void;
  openSettings: () => void;
  toggleSidebar: () => void;
  findEnabled: () => boolean;
  openFind: () => void;
  stepFind: (direction: 1 | -1) => void;
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
  | 'new-note'
  | 'new-tab'
  | 'reopen-tab'
  | 'close-tab'
  | 'search'
  | 'settings'
  | 'toggle-sidebar'
  | 'quit-app';

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
    case 'quit-app':
      closeAppWindow();
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
      // Find stays out of the ShellCommand table on purpose: it has no
      // application-menu item, and stepping carries a direction the table's
      // nullary commands cannot express.
    } else if (key === 'f' && !event.shiftKey) {
      event.preventDefault();
      if (deps.findEnabled()) deps.openFind();
    } else if (key === 'g') {
      event.preventDefault();
      if (deps.findEnabled()) deps.stepFind(event.shiftKey ? -1 : 1);
    } else if (key === 't' && event.shiftKey) {
      event.preventDefault();
      runCommand('reopen-tab', deps);
    } else if (key === 't') {
      event.preventDefault();
      runCommand('new-tab', deps);
    } else if (key === 'w') {
      event.preventDefault();
      runCommand('close-tab', deps);
    } else if (key === 'q' && !isMacAgent()) {
      event.preventDefault();
      runCommand('quit-app', deps);
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
  // Every chord above as a verb; Find's two are the editor's own (OpenFind, StepFind). The
  // window takes them whatever dialog is open, so they stay on offer behind one.
  const unregisterVerbs = registerPuppetVerbs(
    () => [
      puppetVerb(
        'CreateNote',
        {},
        () => {
          // New note on a new note with nothing in it yet does nothing: the buffer only becomes a
          // note once it has text or a title. Answered as a plain 200, a driver that "created two
          // notes" this way wrote into neither and had no id to report.
          const doc = puppetProviders.editor?.getView()?.state.doc;
          if (
            tabsStore.activeNoteId === 'new' &&
            doc?.childCount === 1 &&
            doc.firstChild?.content.size === 0
          ) {
            return puppetRefusal(
              409,
              'a new note is already open and empty, so nothing new was created. It becomes a note once it has text or a title: write into it first',
            );
          }
          runCommand('new-note', deps);
          return undefined;
        },
        { controls: ['notes.newNote'] },
      ),
      puppetVerb('OpenSearch', {}, () => runCommand('search', deps), {
        controls: ['search.heading'],
      }),
      puppetVerb('OpenSettings', {}, () => runCommand('settings', deps), {
        controls: ['settings.openAccessibilityLabel'],
      }),
      puppetVerb('NewTab', {}, () => runCommand('new-tab', deps), {
        controls: ['tabs.newAccessibilityLabel'],
      }),
      // Cmd+W: the tab you are on. A tab's own × is `CloseTabAt`.
      puppetVerb('CloseActiveTab', {}, () => runCommand('close-tab', deps)),
      puppetVerb('ReopenTab', {}, () => runCommand('reopen-tab', deps)),
      // Ctrl+Tab and Ctrl+Shift+Tab.
      puppetVerb('StepTab', { direction: 'integer' }, (args) => {
        if (args.direction === 1) tabsStore.nextTab();
        else if (args.direction === -1) tabsStore.prevTab();
        else return puppetRefusal(400, 'direction must be 1 (next) or -1 (previous)');
        return undefined;
      }),
      // Cmd+1..9: 9 is always the last tab (tabs.md), like the key.
      puppetVerb('ActivateTabByNumber', { number: 'integer' }, (args) => {
        const number = args.number as number;
        if (number < 1 || number > 9) {
          return puppetRefusal(
            400,
            'number is 1-9, the Cmd+1..9 key (9 = the last tab); a click on a tab is ActivateTab {noteId} instead',
          );
        }
        if (number === 9) tabsStore.activateLast();
        else tabsStore.activateByIndex(number - 1);
        return undefined;
      }),
    ],
    { windowShortcuts: true },
  );
  return () => {
    window.removeEventListener('keydown', handleKeydown);
    stopMenu();
    unregisterVerbs();
  };
}

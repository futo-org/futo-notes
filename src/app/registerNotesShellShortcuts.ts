import { tabsStore } from '$features/tabs/tabsStore.svelte';

export interface NotesShellShortcutDeps {
  openSearch: () => void;
  createNote: () => void;
}

function isMacAgent(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);
}

// Desktop tab + navigation accelerators (tabs.md). Ctrl+Tab cycling always uses
// the physical Ctrl key (even on macOS); the primary-modifier accelerators use
// Cmd on macOS and Ctrl elsewhere.
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
      deps.openSearch();
    } else if (key === 'n') {
      event.preventDefault();
      deps.createNote();
    } else if (key === 't' && event.shiftKey) {
      event.preventDefault();
      tabsStore.reopenLastClosed();
    } else if (key === 't') {
      event.preventDefault();
      tabsStore.newTab();
    } else if (key === 'w') {
      event.preventDefault();
      tabsStore.closeActive();
    } else if (/^[1-9]$/.test(event.key)) {
      event.preventDefault();
      const position = Number(event.key);
      // 9 always jumps to the last tab regardless of count (tabs.md).
      if (position === 9) tabsStore.activateLast();
      else tabsStore.activateByIndex(position - 1);
    }
  }

  window.addEventListener('keydown', handleKeydown);
  return () => window.removeEventListener('keydown', handleKeydown);
}

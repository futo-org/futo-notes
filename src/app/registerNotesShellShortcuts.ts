import { isDesktop, isMac } from '$lib/platform';
import { tabsStore } from '$features/tabs/tabsStore.svelte';

interface NotesShellShortcutActions {
  openSearch: () => void;
  createNote: () => void;
}

export function registerNotesShellShortcuts(actions: NotesShellShortcutActions): () => void {
  const handleShortcut = (event: KeyboardEvent): void => {
    const modifierPressed = isMac ? event.metaKey : event.ctrlKey;

    if (isDesktop) {
      if (event.ctrlKey && !event.shiftKey && event.key === 'PageDown') {
        event.preventDefault();
        tabsStore.nextTab();
        return;
      }
      if (event.ctrlKey && !event.shiftKey && event.key === 'PageUp') {
        event.preventDefault();
        tabsStore.prevTab();
        return;
      }
      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault();
        if (event.shiftKey) tabsStore.prevTab();
        else tabsStore.nextTab();
        return;
      }
      if (
        isMac &&
        event.metaKey &&
        event.altKey &&
        (event.key === 'ArrowRight' || event.key === 'ArrowLeft')
      ) {
        event.preventDefault();
        if (event.key === 'ArrowRight') tabsStore.nextTab();
        else tabsStore.prevTab();
        return;
      }

      if (modifierPressed) {
        if (event.key === 't' && !event.shiftKey) {
          event.preventDefault();
          tabsStore.newTab();
          return;
        }
        if (event.key === 'w') {
          event.preventDefault();
          tabsStore.closeActive();
          return;
        }
        if (event.key === 'T' || (event.shiftKey && event.key === 't')) {
          event.preventDefault();
          tabsStore.reopenLastClosed();
          return;
        }
        if (event.key >= '1' && event.key <= '9') {
          event.preventDefault();
          const tabNumber = Number(event.key);
          if (tabNumber === 9) tabsStore.activateLast();
          else tabsStore.activateByIndex(tabNumber - 1);
          return;
        }
      }
    }

    if (!modifierPressed) return;
    if (event.key === 'p') {
      event.preventDefault();
      actions.openSearch();
    } else if (event.key === 'n') {
      event.preventDefault();
      actions.createNote();
    }
  };

  window.addEventListener('keydown', handleShortcut);
  return () => window.removeEventListener('keydown', handleShortcut);
}

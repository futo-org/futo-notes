import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

// Command ids emitted by the macOS application menu
// (apps/tauri/src-tauri/src/app_menu.rs). The shell dispatches them through
// the same table its keyboard accelerators use.
const APP_MENU_EVENT = 'app-menu';

export interface ApplicationMenuLabels {
  file: string;
  edit: string;
  view: string;
  window: string;
  settings: string;
  newNote: string;
  newTab: string;
  reopenClosedTab: string;
  searchNotes: string;
  closeTab: string;
  closeWindow: string;
  toggleSidebar: string;
}

export async function subscribeToAppMenu(handler: (command: string) => void): Promise<() => void> {
  return listen<string>(APP_MENU_EVENT, (event) => handler(event.payload));
}

export async function applyApplicationMenuLabels(labels: ApplicationMenuLabels): Promise<void> {
  await invoke<void>('app_menu_set_labels', { labels });
}

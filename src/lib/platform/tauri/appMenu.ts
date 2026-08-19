import { listen } from '@tauri-apps/api/event';

// Command ids emitted by the macOS application menu
// (apps/tauri/src-tauri/src/app_menu.rs). The shell dispatches them through
// the same table its keyboard accelerators use.
const APP_MENU_EVENT = 'app-menu';

export async function subscribeToAppMenu(handler: (command: string) => void): Promise<() => void> {
  return listen<string>(APP_MENU_EVENT, (event) => handler(event.payload));
}

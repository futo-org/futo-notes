import { getCurrentWindow } from '@tauri-apps/api/window';

// `null` hands the window back to the OS. On macOS this is NSApp.appearance
// (tao's set_theme sets it app-wide, so the menu bar and native dialogs move
// with the window) — `null` clears it to nil, which is what "follow the system"
// means to AppKit.
export async function applyNativeWindowAppearance(theme: 'dark' | 'light' | null): Promise<void> {
  await getCurrentWindow().setTheme(theme);
}

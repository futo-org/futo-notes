import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

type NativeTheme = 'dark' | 'light';

// `null` hands the window back to the OS. On macOS this is NSApp.appearance
// (tao's set_theme sets it app-wide, so the menu bar and native dialogs move
// with the window) — `null` clears it to nil, which is what "follow the system"
// means to AppKit.
export async function applyNativeWindowAppearance(theme: NativeTheme | null): Promise<void> {
  await getCurrentWindow().setTheme(theme);
}

// On macOS handing the window back to the OS reports no ThemeChanged — measured
// on macOS 26, tao emits none for the app's own pin or unpin — so the OS answer
// is read straight off the released window instead.
export async function releaseNativeWindowAppearance(): Promise<NativeTheme | null> {
  const appWindow = getCurrentWindow();
  await appWindow.setTheme(null);
  return appWindow.theme();
}

// tao reports ThemeChanged on macOS and Windows; Linux reports nothing there,
// so the desktop portal watcher in Rust emits `linux-theme-changed` instead.
export async function subscribeToNativeThemeChanges(
  onChange: (theme: NativeTheme) => void,
): Promise<() => void> {
  const [unlistenWindow, unlistenPortal] = await Promise.all([
    getCurrentWindow().onThemeChanged(({ payload }) => onChange(payload)),
    listen<NativeTheme>('linux-theme-changed', ({ payload }) => onChange(payload)),
  ]);
  return () => {
    unlistenWindow();
    unlistenPortal();
  };
}

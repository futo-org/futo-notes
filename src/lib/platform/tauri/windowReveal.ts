import { getCurrentWindow } from '@tauri-apps/api/window';

// The window is created hidden (`"visible": false` in every window config) so
// the user never sees WKWebView's opaque white before the first frame. Rust
// reveals it unconditionally after a timeout; this is the fast path.
export async function showAppWindow(): Promise<void> {
  await getCurrentWindow().show();
}

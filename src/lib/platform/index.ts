import type { PlatformFS, PlatformName } from './types';
export type {
  FileChangeEvent,
  PlatformFS,
  PlatformName,
  PlatformStorage,
  NativeCapabilities,
  DirFileEntry,
} from './types';

function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function detectPlatform(): PlatformName {
  if (hasTauriRuntime()) {
    return 'tauri';
  }
  return 'web';
}

export const platformName: PlatformName = detectPlatform();
export const isTauri = platformName === 'tauri';

export const isDesktop = isTauri;
export const isLinux = typeof navigator !== 'undefined' && /\blinux\b/i.test(navigator.userAgent);
// True on iOS hardware — the native-shell embed's WKWebView and iOS Safari.
// iPads masquerade as "Macintosh" in modern WebKit UAs, so also treat
// Mac-with-multitouch as iOS (desktop Macs report maxTouchPoints 0). This
// was a hardcoded `false` left over from the removed Tauri-iOS shell, which
// silently disabled the editorPointerInteractions touchend path inside the native iOS
// embed — first tap landed the cursor at position 0 (2026-07-02 QA).
export const isIOS =
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (/Mac/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1));
// "Apple platform" — true on macOS desktop and on iOS hardware keyboards.
// Used to route ⌘ vs Ctrl in keyboard shortcuts. For desktop-only checks
// (titlebar styling, traffic-light insets) gate on `isDesktop && isMac`.
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);

// Native application-menu commands (macOS). Off Tauri — the web dev server and
// the native mobile editor embed — there is no menu, so this is a no-op
// subscription rather than a branch every caller has to remember.
export function onAppMenuCommand(handler: (command: string) => void): () => void {
  if (platformName !== 'tauri') return () => {};
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void import('./tauri/appMenu')
    .then(({ subscribeToAppMenu }) => subscribeToAppMenu(handler))
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch((error) => console.warn('Failed to subscribe to the app menu:', error));
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

// Reveal the desktop window once the shell has painted. The window is created
// hidden so the launch never flashes WKWebView's white; see
// apps/tauri/src-tauri/src/window_reveal.rs, which shows it anyway after a
// timeout so a frontend that never paints cannot hide the app forever.
export function revealAppWindow(): void {
  if (platformName !== 'tauri') return;
  void import('./tauri/windowReveal')
    .then(({ showAppWindow }) => showAppWindow())
    .catch((error) => console.warn('Failed to reveal the app window:', error));
}

// Keep the native window in the same appearance as the app's theme, or pass
// `null` to leave it following the OS.
//
// The window FRAME is not ours to paint: the OS draws it in the window's own
// appearance. On macOS AppKit strokes a highlight along the top edge whose
// brightness is chosen for that appearance, and it composites over our pixels —
// measured on the #171717 top band, white@55% (rgb 150,150,150) for a
// light-appearance window against white@20% (rgb 66,66,66) for a dark one. So a
// window left in the system's light appearance while the app renders its dark
// theme wears a bright hairline along its top edge, glaring against a dark
// desktop, where a dark window wears the same subtle edge as every native dark
// app. Nothing in the DOM can reach it; the appearance has to.
//
// Off Tauri (web dev server, the native mobile WebView embeds) there is no
// window to dress, so this is a no-op rather than a branch at the call site.
export function setNativeWindowAppearance(theme: 'dark' | 'light' | null): void {
  if (platformName !== 'tauri') return;
  void import('./tauri/windowAppearance')
    .then(({ applyNativeWindowAppearance }) => applyNativeWindowAppearance(theme))
    .catch((error) => console.warn('Failed to set the native window appearance:', error));
}

// Lazy-loaded platform filesystem implementation
let _fs: PlatformFS | null = null;

export async function getPlatformFS(): Promise<PlatformFS> {
  if (_fs) return _fs;

  if (platformName === 'tauri') {
    const { tauriFS } = await import('./tauri');
    _fs = tauriFS;
  } else {
    const { webFS } = await import('./web');
    _fs = webFS;
  }

  return _fs;
}

// For code that needs synchronous access after init
export function getFS(): PlatformFS {
  if (!_fs) throw new Error('Platform FS not initialized — call getPlatformFS() first');
  return _fs;
}

// Whether this platform has real file I/O (web dev mode uses in-memory store)
export const hasFileSystem = platformName !== 'web' || import.meta.env.DEV;

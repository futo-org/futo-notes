import type { PlatformFS, PlatformName } from './types';
export type { NoteFile, FileChangeEvent, PlatformFS, PlatformName, FileSystem, NativeCapabilities, DirFileEntry, FolderEntry } from './types';

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
export const isMobile = false;
export const isLinux = typeof navigator !== 'undefined' && /\blinux\b/i.test(navigator.userAgent);
// True on iOS hardware — the native-shell embed's WKWebView and iOS Safari.
// iPads masquerade as "Macintosh" in modern WebKit UAs, so also treat
// Mac-with-multitouch as iOS (desktop Macs report maxTouchPoints 0). This
// was a hardcoded `false` left over from the removed Tauri-iOS shell, which
// silently disabled the iosTapFocus touchend path inside the native iOS
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

/** Narrow accessor: core file I/O only (no supersearch/graph methods). */
export function getFileSystem(): import('./types').FileSystem {
  return getFS();
}

/** Narrow accessor: platform-specific capabilities (supersearch, graph, etc.). */
export function getNativeCapabilities(): import('./types').NativeCapabilities {
  return getFS();
}

export async function ensureNotesFolder(): Promise<void> {
  // Tauri and web do not need explicit folder setup.
}

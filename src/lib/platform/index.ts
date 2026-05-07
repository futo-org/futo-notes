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

function detectMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

const tauriMobile = isTauri && detectMobileDevice();
export const isDesktop = isTauri && !tauriMobile;
export const isMobile = tauriMobile;
export const isLinux = typeof navigator !== 'undefined' && /\blinux\b/i.test(navigator.userAgent);
export const isAndroid =
  isTauri && typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
export const isIOS =
  isTauri &&
  typeof navigator !== 'undefined' &&
  /iphone|ipad|ipod/i.test(navigator.userAgent);

let softKeyboardPrimer: HTMLInputElement | null = null;

function removeSoftKeyboardPrimer(): void {
  const primer = softKeyboardPrimer;
  softKeyboardPrimer = null;
  if (!primer) return;

  requestAnimationFrame(() => {
    if (document.activeElement === primer) primer.blur();
    primer.remove();
  });
}

/**
 * Preserve iOS' tap-triggered keyboard activation across async navigation.
 *
 * WKWebView only opens the software keyboard when focus happens during a user
 * gesture. Creating a new note has to flush/save and route before the editor
 * exists, so the eventual CodeMirror `.focus()` happens too late. Focusing a
 * small input synchronously during the tap opens the keyboard; the later
 * editor focus then inherits that active keyboard session.
 */
export function primeSoftKeyboardForProgrammaticFocus(): void {
  if (!isIOS || typeof document === 'undefined') return;
  if (softKeyboardPrimer?.isConnected) {
    softKeyboardPrimer.focus({ preventScroll: true });
    return;
  }

  const primer = document.createElement('input');
  primer.type = 'text';
  primer.setAttribute('aria-hidden', 'true');
  primer.setAttribute('data-futo-keyboard-primer', 'true');
  primer.setAttribute('inputmode', 'text');
  primer.tabIndex = -1;
  primer.autocapitalize = 'off';
  primer.autocomplete = 'off';
  primer.spellcheck = false;
  primer.style.cssText = [
    'position: fixed',
    'left: 50%',
    'bottom: 0',
    'width: 32px',
    'height: 32px',
    'opacity: 0.01',
    'border: 0',
    'padding: 0',
    'margin: 0',
    'font-size: 16px',
    'background: transparent',
    'color: transparent',
    'caret-color: transparent',
    'transform: translateX(-50%)',
    'z-index: 2147483647',
  ].join('; ');

  document.body.appendChild(primer);
  softKeyboardPrimer = primer;
  primer.focus({ preventScroll: true });
}

/**
 * Raise the soft keyboard / IME for the focused webview. No-op on desktop.
 * Wraps the `show_soft_keyboard` Tauri command, which on Android calls
 * `InputMethodManager.showSoftInput` via JNI and on iOS calls
 * `becomeFirstResponder` on the WKWebView.
 *
 * Use after a programmatic `.focus()` on the editor or any contenteditable
 * — both Android Chrome and iOS WKWebView gate keyboard display on a real
 * user gesture, so non-gesture focus needs this hint.
 */
export async function showSoftKeyboard(): Promise<void> {
  if (!isAndroid && !isIOS) return;
  removeSoftKeyboardPrimer();
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('show_soft_keyboard');
  } catch {
    // Best-effort: a missing or failing native IME call should never break
    // the calling flow. The user can still tap to bring up the keyboard.
  }
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

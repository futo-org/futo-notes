import type { PlatformFS, PlatformName } from './types';
export type { NoteFile, FileChangeEvent, PlatformFS, PlatformName } from './types';

function detectPlatform(): PlatformName {
  if (typeof window !== 'undefined' && 'electronAPI' in window) {
    return 'electron';
  }
  if (typeof window !== 'undefined' && 'Capacitor' in window && (window as any).Capacitor?.isNativePlatform?.()) {
    return 'capacitor';
  }
  return 'web';
}

export const platformName: PlatformName = detectPlatform();
export const isElectron = platformName === 'electron';
export const isCapacitor = platformName === 'capacitor';
export const isDesktop = platformName === 'electron';
export const isMobile = platformName === 'capacitor';

// Lazy-loaded platform filesystem implementation
let _fs: PlatformFS | null = null;

export async function getPlatformFS(): Promise<PlatformFS> {
  if (_fs) return _fs;

  switch (platformName) {
    case 'electron': {
      const { electronFS } = await import('./electron');
      _fs = electronFS;
      break;
    }
    case 'capacitor': {
      const { capacitorFS } = await import('./capacitor');
      _fs = capacitorFS;
      break;
    }
    default: {
      const { webFS } = await import('./web');
      _fs = webFS;
      break;
    }
  }

  return _fs;
}

// For code that needs synchronous access after init
export function getFS(): PlatformFS {
  if (!_fs) throw new Error('Platform FS not initialized — call getPlatformFS() first');
  return _fs;
}

// Whether this platform has real file I/O
export const hasFileSystem = platformName !== 'web';

/** Ensure notes storage is ready. On Capacitor, creates subfolder + migrates. No-op elsewhere. */
export async function ensureNotesFolder(): Promise<void> {
  if (platformName === 'capacitor') {
    const { ensureCapacitorNotesFolder } = await import('./capacitor');
    await ensureCapacitorNotesFolder();
  }
  // Electron and web need no folder setup
}

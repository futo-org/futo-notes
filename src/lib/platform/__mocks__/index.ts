export type { NoteFile, FileChangeEvent, PlatformFS, PlatformName } from '../types';

import { createNodeFS } from '../__test__/nodeFS';
import type { PlatformFS, PlatformName } from '../types';
import type { TestPlatformFS } from '../__test__/nodeFS';

// Store on globalThis so the same instance persists across vi.resetModules()
const g = globalThis as unknown as { __futoTestFS?: TestPlatformFS };
if (!g.__futoTestFS) {
  g.__futoTestFS = createNodeFS();
}
export const testFS = g.__futoTestFS;

export const platformName: PlatformName = 'web';
export const isElectron = false;
export const isCapacitor = false;
export const isDesktop = false;
export const isMobile = false;
export const hasFileSystem = true;

export async function getPlatformFS(): Promise<PlatformFS> {
  return testFS;
}

export function getFS(): PlatformFS {
  return testFS;
}

export async function ensureNotesFolder(): Promise<void> {
  // no-op in tests
}

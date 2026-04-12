export type { NoteFile, FileChangeEvent, PlatformFS, PlatformName, DirFileEntry } from '../types';

import { createNodeFS } from '../__test__/nodeFS';
import type { PlatformFS, PlatformName } from '../types';
import type { TestPlatformFS } from '../__test__/nodeFS';

// Store on globalThis so the same instance persists across vi.resetModules()
const g = globalThis as unknown as {
  __futoTestFS?: TestPlatformFS;
  __futoActiveFS?: TestPlatformFS;
};
if (!g.__futoTestFS) {
  g.__futoTestFS = createNodeFS();
}
if (!g.__futoActiveFS) {
  g.__futoActiveFS = g.__futoTestFS;
}
export const testFS = g.__futoTestFS;

/** Switch the active FS used by getFS()/getPlatformFS(). Survives vi.resetModules(). */
export function setActiveFS(fs: TestPlatformFS): void {
  g.__futoActiveFS = fs;
}

/** Reset the active FS back to the default testFS. */
export function resetActiveFS(): void {
  g.__futoActiveFS = g.__futoTestFS;
}

export { createNodeFS };
export type { TestPlatformFS };

export const platformName: PlatformName = 'web';
export const isTauri = false;
export const isDesktop = false;
export const isMobile = false;
export const hasFileSystem = true;

export async function getPlatformFS(): Promise<PlatformFS> {
  return g.__futoActiveFS!;
}

export function getFS(): PlatformFS {
  return g.__futoActiveFS!;
}

export async function ensureNotesFolder(): Promise<void> {
  // no-op in tests
}

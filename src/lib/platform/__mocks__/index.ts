export type { FileChangeEvent, PlatformFS, PlatformName, DirFileEntry } from '../types';

import { createNodeFS, type TestPlatformFS } from '../__test__/nodeFS';
import type { PlatformFS, PlatformName } from '../types';

const globalStore = globalThis as unknown as {
  __futoTestFS?: TestPlatformFS;
  __futoActiveFS?: TestPlatformFS;
};
globalStore.__futoTestFS ??= createNodeFS();
globalStore.__futoActiveFS ??= globalStore.__futoTestFS;

export const testFS = globalStore.__futoTestFS;
export { createNodeFS };
export type { TestPlatformFS };

export function setActiveFS(fs: TestPlatformFS): void {
  globalStore.__futoActiveFS = fs;
}

export function resetActiveFS(): void {
  globalStore.__futoActiveFS = globalStore.__futoTestFS;
}

export const platformName: PlatformName = 'web';
export const isTauri = false;
export const isDesktop = false;
export const hasFileSystem = true;

export async function getPlatformFS(): Promise<PlatformFS> {
  return globalStore.__futoActiveFS!;
}

export function getFS(): PlatformFS {
  return globalStore.__futoActiveFS!;
}

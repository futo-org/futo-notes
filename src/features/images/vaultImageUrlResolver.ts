/*
 * Installs the per-file vault image URL producer. Each file resolves
 * individually through `PlatformFS.getImageUrl` (asset protocol, `blob:`
 * fallback), which is asynchronous, so it cannot happen inside a render.
 *
 * The editor asks per image actually rendered instead of scanning the whole
 * document, so a large note only pays for what someone looks at (M5).
 */
import { getPlatformFS } from '$lib/platform';

import { setVaultImageUrlResolver } from './vaultImageSrc';

/**
 * A plain browser (Playwright, the factory judge, `pnpm run dev`) gets one whose
 * every answer is "not there".
 *
 * The platform is asked for when an image is, not now: the editor mounts with
 * the restored tab before bootstrap has resolved it, and a resolver skipped then
 * left every vault image of the session missing.
 *
 * The decision lives here rather than in the editor component because
 * components never branch on platform (src/AGENTS.md).
 */
export function installVaultImageUrlResolver(): void {
  setVaultImageUrlResolver(async (filename) => (await getPlatformFS()).getImageUrl(filename));
}

/** Drops whatever {@link installVaultImageUrlResolver} installed. */
export function uninstallVaultImageUrlResolver(): void {
  setVaultImageUrlResolver(null);
}

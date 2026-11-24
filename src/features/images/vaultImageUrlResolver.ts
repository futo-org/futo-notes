/*
 * Installs the per-file vault image URL producer for the host we are running in.
 *
 * The two hosts resolve a vault image two different ways, and only one of them
 * needs anything installed:
 *
 *   - Native shells (iOS/Android) register ONE base URL over the bridge that
 *     serves the whole vault root, and every filename hangs off it. Nothing to
 *     do here, and installing a resolver would actively break them: the web
 *     `PlatformFS.getImageUrl` throws inside a shell, and a per-file entry —
 *     junk or not — wins over the base URL for the rest of the session.
 *   - Tauri desktop has no base URL. Each file resolves individually through
 *     `PlatformFS.getImageUrl` (asset protocol, `blob:` fallback), which is
 *     asynchronous, so it cannot happen inside a render.
 *
 * The editor asks per image actually rendered instead of scanning the whole
 * document, so a large note only pays for what someone looks at (M5).
 */
import { hasNativeBridgeHost } from '@futo-notes/editor';

import { getPlatformFS } from '$lib/platform';

import { setVaultImageUrlResolver } from './vaultImageSrc';

/**
 * Returns whether a resolver was installed — false means this host resolves
 * images some other way (a base URL). A plain browser (Playwright, the factory
 * judge, `pnpm run dev`) gets one whose every answer is "not there".
 *
 * The platform is asked for when an image is, not now: the editor mounts with
 * the restored tab before bootstrap has resolved it, and a resolver skipped then
 * left every vault image of the session missing.
 *
 * The decision lives here rather than in the editor component because
 * components never branch on platform (src/AGENTS.md).
 */
export function installVaultImageUrlResolver(): boolean {
  if (hasNativeBridgeHost()) return false;
  setVaultImageUrlResolver(async (filename) => (await getPlatformFS()).getImageUrl(filename));
  return true;
}

/** Drops whatever {@link installVaultImageUrlResolver} installed. */
export function uninstallVaultImageUrlResolver(): void {
  setVaultImageUrlResolver(null);
}

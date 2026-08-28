/**
 * Where a vault-relative image reference turns into something a browser can
 * load — the single owner of that mapping for every editor engine.
 *
 * Notes reference images by bare filename (`![](image-1712.png)`), which is
 * what has to stay on disk. What resolves that filename differs per shell:
 *
 *   - iOS/Android: the host registers ONE base URL (`setImageBaseUrl` on the
 *     bridge) that serves the vault root — `futo-asset://` on iOS, a
 *     `WebViewAssetLoader` path on Android — and every filename hangs off it.
 *   - Tauri desktop: there is no base URL. Each file resolves individually
 *     through the asset protocol (or a `blob:` fallback when the asset
 *     protocol cannot decode), so the resolved URL is registered per file.
 *
 * This module lives outside `features/editor/live-preview/` on purpose: that
 * directory is CodeMirror-only and is deleted with CM6 at the Milkdown swap
 * (docs/plan/milkdown-transition.md §7), while both engines need this mapping.
 * `features/images/` already owns renderable vault URLs (src/AGENTS.md).
 */

/** Per-file resolved URLs, which win over the base URL when present. */
const vaultImageUrls = new Map<string, string>();

let vaultImageBaseUrl = '';

/**
 * How THIS host turns one vault filename into a loadable URL, when there is no
 * base URL to hang it off. Only Tauri desktop has one (`PlatformFS.getImageUrl`
 * — asset protocol, or a `blob:` when the asset protocol cannot decode); the
 * native shells register a base URL instead and leave this unset.
 */
type VaultImageUrlResolver = (filename: string) => Promise<string>;

let urlResolver: VaultImageUrlResolver | null = null;

/** Filenames the resolver is working on, so N renders cost one round trip. */
const inFlight = new Set<string>();

/**
 * Live renderers that must re-resolve when the mapping changes. A ProseMirror
 * node view has no other way to hear about it: the base URL can arrive AFTER
 * the content (the boot order only guarantees it for `initialize`, and a
 * desktop `getImageUrl` resolves asynchronously), and no document transaction
 * accompanies either event, so nothing would otherwise re-render the image.
 */
const subscribers = new Set<() => void>();

function notify(): void {
  for (const subscriber of subscribers) {
    try {
      subscriber();
    } catch (error) {
      // One broken renderer must not stop the others from re-resolving.
      console.warn('vaultImageSrc: subscriber failed', error);
    }
  }
}

/** Whether a source is already loadable as-is and must not be rewritten. */
export function isRemoteImageSource(source: string): boolean {
  return (
    source.startsWith('http://') || source.startsWith('https://') || source.startsWith('data:')
  );
}

/**
 * The URL to load for an image reference, or `''` when a vault filename cannot
 * be resolved yet. Callers render an empty `src` as "no image yet" rather than
 * a broken-image glyph — the base URL may still be on its way.
 */
export function resolveVaultImageSrc(source: string): string {
  if (isRemoteImageSource(source)) return source;
  const registered = vaultImageUrls.get(source);
  if (registered !== undefined) return registered;
  return vaultImageBaseUrl ? vaultImageBaseUrl + encodeURIComponent(source) : '';
}

/**
 * The URL registered for one filename, if any — the base URL is deliberately
 * NOT consulted. CodeMirror's preloader needs the distinction: a filename with
 * nothing registered is the only case worth an async `getImageUrl` round trip.
 */
export function registeredVaultImageUrl(filename: string): string | undefined {
  return vaultImageUrls.get(filename);
}

/** Register the URL a single vault filename resolves to (Tauri desktop). */
export function registerVaultImageUrl(filename: string, url: string): void {
  const previous = vaultImageUrls.get(filename);
  if (previous === url) return;
  if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous);
  vaultImageUrls.set(filename, url);
  notify();
}

/** Register the vault-root base URL every filename hangs off (native shells). */
export function setVaultImageBaseUrl(baseUrl: string): void {
  if (baseUrl === vaultImageBaseUrl) return;
  vaultImageBaseUrl = baseUrl;
  notify();
}

export function clearVaultImageUrlCache(): void {
  for (const url of vaultImageUrls.values()) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  vaultImageUrls.clear();
  inFlight.clear();
  /* Notify like the other two mutators: a live renderer still holding a src
   * that was just revoked has to drop it. */
  notify();
}

export function setVaultImageUrlResolver(resolve: VaultImageUrlResolver | null): void {
  urlResolver = resolve;
}

/**
 * Ask the host to resolve a filename nothing has registered yet, registering
 * the result (which notifies, so the renderer that asked re-resolves itself).
 *
 * Fire-and-forget by design: it is called from a render path, so it must not
 * be awaited and must not throw. Called per image actually rendered rather
 * than by scanning the whole document, so a large note only pays for the
 * images someone looks at (M5).
 */
export function requestVaultImageUrl(filename: string): void {
  if (!urlResolver) return;
  if (!filename || isRemoteImageSource(filename)) return;
  if (vaultImageUrls.has(filename) || inFlight.has(filename)) return;

  inFlight.add(filename);
  void urlResolver(filename)
    .then((url) => {
      inFlight.delete(filename);
      if (url) registerVaultImageUrl(filename, url);
    })
    .catch(() => {
      /* The file may simply not have arrived yet — sync delivers an image
       * alongside its note, not necessarily before it. Forget the attempt so a
       * later render can ask again, and stay quiet: a missing image is not an
       * error the user needs told about. */
      inFlight.delete(filename);
    });
}

/** Subscribe to mapping changes. Returns the unsubscribe. */
export function onVaultImageSrcChange(onChange: () => void): () => void {
  subscribers.add(onChange);
  return () => subscribers.delete(onChange);
}

/**
 * Where a vault-relative image reference turns into something a browser can
 * load — the single owner of that mapping.
 *
 * Notes reference images by bare filename (`![](image-1712.png)`), which is
 * what has to stay on disk. On Tauri desktop each file resolves individually
 * through the asset protocol (or a `blob:` fallback when the asset protocol
 * cannot decode), so the resolved URL is registered per file.
 */

/** Per-file resolved URLs. */
const vaultImageUrls = new Map<string, string>();

/**
 * How THIS host turns one vault filename into a loadable URL. Only Tauri desktop
 * has one (`PlatformFS.getImageUrl` — asset protocol, or a `blob:` when the asset
 * protocol cannot decode).
 */
type VaultImageUrlResolver = (filename: string) => Promise<string>;

let urlResolver: VaultImageUrlResolver | null = null;

/** Filenames the resolver is working on, each with its answer, so N renders cost one round
 *  trip. */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Live renderers that must re-resolve when the mapping changes. A drawn picture
 * has no other way to hear about it: a desktop `getImageUrl` resolves
 * asynchronously, after the content, and no edit accompanies it, so nothing
 * would otherwise redraw the image.
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
function isRemoteImageSource(source: string): boolean {
  return (
    source.startsWith('http://') || source.startsWith('https://') || source.startsWith('data:')
  );
}

/**
 * The URL to load for an image reference, or `''` when a vault filename cannot
 * be resolved yet. Callers render an empty `src` as "no image yet" rather than
 * a broken-image glyph — the URL may still be on its way.
 */
export function resolveVaultImageSrc(source: string): string {
  if (isRemoteImageSource(source)) return source;
  return vaultImageUrls.get(source) ?? '';
}

/** Register the URL a single vault filename resolves to (Tauri desktop). */
export function registerVaultImageUrl(filename: string, url: string): void {
  const previous = vaultImageUrls.get(filename);
  if (previous === url) return;
  if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous);
  vaultImageUrls.set(filename, url);
  notify();
}

export function clearVaultImageUrlCache(): void {
  for (const url of vaultImageUrls.values()) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  vaultImageUrls.clear();
  inFlight.clear();
  /* Notify like the other mutator: a live renderer still holding a src
   * that was just revoked has to drop it. */
  notify();
}

export function setVaultImageUrlResolver(resolve: VaultImageUrlResolver | null): void {
  urlResolver = resolve;
}

/**
 * Ask the host to resolve a filename nothing has registered yet, registering
 * the result (which notifies, so the renderer that asked re-resolves itself).
 * Answers whether the filename has a URL now: false when it will not resolve
 * (no resolver here, or the file is not there), so a renderer that wants to
 * can say so; a later request asks again.
 *
 * Never awaited by a render path and never throws. Called per image actually
 * rendered rather than by scanning the whole document, so a large note only
 * pays for the images someone looks at (M5).
 */
export function requestVaultImageUrl(filename: string): Promise<boolean> {
  if (!filename) return Promise.resolve(false);
  if (isRemoteImageSource(filename) || vaultImageUrls.has(filename)) return Promise.resolve(true);
  if (!urlResolver) return Promise.resolve(false);
  const pending = inFlight.get(filename);
  if (pending) return pending;

  const answer = urlResolver(filename)
    .then((url) => {
      inFlight.delete(filename);
      if (url) registerVaultImageUrl(filename, url);
      return !!url;
    })
    .catch(() => {
      /* The file may simply not have arrived yet — sync delivers an image
       * alongside its note, not necessarily before it. Forget the attempt so a
       * later render can ask again, and stay quiet: a missing image is not an
       * error the user needs told about. */
      inFlight.delete(filename);
      return false;
    });
  inFlight.set(filename, answer);
  return answer;
}

/** Subscribe to mapping changes. Returns the unsubscribe. */
export function onVaultImageSrcChange(onChange: () => void): () => void {
  subscribers.add(onChange);
  return () => subscribers.delete(onChange);
}

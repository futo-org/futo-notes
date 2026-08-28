import { StateEffect } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';

import {
  clearVaultImageUrlCache,
  isRemoteImageSource,
  registerVaultImageUrl,
  registeredVaultImageUrl,
  resolveVaultImageSrc,
  setVaultImageBaseUrl,
} from '$features/images/vaultImageSrc';

export const imageCacheUpdated = StateEffect.define<null>();

const MAX_IMAGE_HEIGHT = 300;
const IMAGE_PATTERN = /!\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;
const imageSizes = new Map<string, { width: number; height: number }>();

/* The vault filename -> loadable URL mapping itself lives in
 * `features/images/vaultImageSrc.ts`, which both editor engines share and which
 * outlives this CodeMirror-only directory (docs/plan/milkdown-transition.md §7).
 * These names stay as the aliases the CM6 call sites and the
 * `liveMarkdownTransform` facade already use. */
export {
  clearVaultImageUrlCache as clearLocalImageUrlCache,
  registerVaultImageUrl as registerLocalImageUrl,
  resolveVaultImageSrc as resolveImageSrc,
  setVaultImageBaseUrl as setLocalImageBaseUrl,
};

export function preloadImages(
  markdown: string,
  getImageUrl?: (filename: string) => Promise<string>,
  getView?: () => EditorView | null,
): void {
  if (!markdown.includes('![')) return;

  IMAGE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_PATTERN.exec(markdown)) !== null) {
    const source = match[1];
    if (isRemoteImageSource(source)) {
      preloadImage(source);
      continue;
    }

    /* A registered per-file URL takes priority; only then is an async
     * `getImageUrl` worth a round trip; a base URL alone resolves without one.
     * `resolveVaultImageSrc` returns '' when nothing can resolve the filename
     * yet, which is the only case that reaches `getImageUrl`. */
    const registered = registeredVaultImageUrl(source);
    if (registered) {
      preloadImage(registered);
    } else if (getImageUrl) {
      void getImageUrl(source)
        .then((url) => {
          registerVaultImageUrl(source, url);
          preloadImage(url);
          getView?.()?.dispatch({ effects: imageCacheUpdated.of(null) });
        })
        .catch(() => undefined);
    } else {
      const fromBase = resolveVaultImageSrc(source);
      if (fromBase) preloadImage(fromBase);
    }
  }
}

export class ImageWidget extends WidgetType {
  private readonly resolvedUrl: string;
  private renderedSizeObserver: ResizeObserver | undefined;

  constructor(
    private readonly alt: string,
    private readonly source: string,
    private readonly endPosition: number,
  ) {
    super();
    this.resolvedUrl = resolveVaultImageSrc(source);
  }

  /// The one key this widget's size is cached under. Reads and writes must agree:
  /// they used to disagree for an unresolved source (`resolvedUrl` alone when
  /// reading in toDOM, `resolvedUrl || source` everywhere else), so a cached
  /// measurement could never be found again.
  private get sizeCacheKey(): string {
    return this.resolvedUrl || this.source;
  }

  get estimatedHeight(): number {
    return imageSizes.get(this.sizeCacheKey)?.height ?? 200;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-md-image-wrapper';

    const cachedSize = imageSizes.get(this.sizeCacheKey);
    wrapper.style.cssText = `min-height: ${cachedSize?.height ?? 200}px;`;

    const image = document.createElement('img');
    image.alt = this.alt;
    image.className = 'cm-md-image-widget';
    if (this.resolvedUrl) image.src = this.resolvedUrl;
    if (cachedSize) {
      image.width = cachedSize.width;
      image.height = cachedSize.height;
    }

    // Reserve the image's real footprint as a FLOOR (min-height), never as a
    // pinned `height`. The image is width-constrained (`max-width: 100%`), so its
    // rendered height changes with the editor's content width — a device
    // rotation, or the iOS shared WebView being adopted into real bounds after
    // its zero-size prewarm. A pinned height measured at the narrower width plus
    // the wrapper's `overflow: hidden` silently CLIPPED the bottom of the image;
    // a floor lets the wrapper grow with its content instead.
    const commitRenderedFootprint = () => {
      const height = image.offsetHeight;
      // A measurement taken before layout (zero-width host) is not a real
      // footprint: committing it would pin a too-short floor, and caching it
      // would poison estimatedHeight for every later widget on this URL.
      if (height <= 0) return;
      // Last-measurement-wins, unlike preloadImage's first-write-wins estimate:
      // this is the real rendered footprint at the CURRENT width, so a stale
      // entry from a narrower editor must not survive it.
      imageSizes.set(this.sizeCacheKey, { width: image.offsetWidth, height });
      wrapper.style.cssText = `min-height: ${height}px;`;
      // CM6 measures a widget's height at its initial paint only. Both the image
      // load and any later width change land well after that, leaving CM6's
      // internal height cache (used for scroll/viewport math) on a stale
      // estimate until the next transaction — ask it to re-measure now.
      view.requestMeasure();
    };

    image.onload = commitRenderedFootprint;
    // Width changes arrive without a load event and without a transaction, so
    // the load handler alone cannot keep the footprint honest.
    if (typeof ResizeObserver !== 'undefined') {
      this.renderedSizeObserver = new ResizeObserver(commitRenderedFootprint);
      this.renderedSizeObserver.observe(image);
    }

    wrapper.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const position = Math.min(this.endPosition, view.state.doc.length);
      view.dispatch({ selection: { anchor: view.state.doc.lineAt(position).to } });
      view.focus();
    });
    wrapper.appendChild(image);
    return wrapper;
  }

  destroy(): void {
    this.renderedSizeObserver?.disconnect();
    this.renderedSizeObserver = undefined;
  }

  eq(other: ImageWidget): boolean {
    return other.source === this.source && other.resolvedUrl === this.resolvedUrl;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function preloadImage(url: string): void {
  if (imageSizes.has(url)) return;

  const image = new Image();
  image.src = url;
  image.onload = () => {
    if (imageSizes.has(url)) return;
    const scale =
      image.naturalHeight > MAX_IMAGE_HEIGHT ? MAX_IMAGE_HEIGHT / image.naturalHeight : 1;
    imageSizes.set(url, {
      width: Math.round(image.naturalWidth * scale),
      height: Math.round(image.naturalHeight * scale),
    });
  };
}

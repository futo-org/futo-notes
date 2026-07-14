import { StateEffect } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';

export const imageCacheUpdated = StateEffect.define<null>();

const MAX_IMAGE_HEIGHT = 300;
const IMAGE_PATTERN = /!\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;
const imageSizes = new Map<string, { width: number; height: number }>();
const localImageUrls = new Map<string, string>();

let localImageBaseUrl = '';

export function clearLocalImageUrlCache(): void {
  for (const url of localImageUrls.values()) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  localImageUrls.clear();
}

export function resolveImageSrc(source: string): string {
  if (isRemoteSource(source)) return source;
  const cachedUrl = localImageUrls.get(source);
  if (cachedUrl !== undefined) return cachedUrl;
  return localImageBaseUrl ? localImageBaseUrl + encodeURIComponent(source) : '';
}

export function registerLocalImageUrl(filename: string, url: string): void {
  const previousUrl = localImageUrls.get(filename);
  if (previousUrl !== url && previousUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(previousUrl);
  }
  localImageUrls.set(filename, url);
}

export function setLocalImageBaseUrl(baseUrl: string): void {
  localImageBaseUrl = baseUrl;
}

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
    if (isRemoteSource(source)) {
      preloadImage(source);
      continue;
    }

    const cachedUrl = localImageUrls.get(source);
    if (cachedUrl) {
      preloadImage(cachedUrl);
    } else if (getImageUrl) {
      void getImageUrl(source)
        .then((url) => {
          registerLocalImageUrl(source, url);
          preloadImage(url);
          getView?.()?.dispatch({ effects: imageCacheUpdated.of(null) });
        })
        .catch(() => undefined);
    } else if (localImageBaseUrl) {
      preloadImage(localImageBaseUrl + encodeURIComponent(source));
    }
  }
}

export class ImageWidget extends WidgetType {
  private readonly resolvedUrl: string;

  constructor(
    private readonly alt: string,
    private readonly source: string,
    private readonly endPosition: number,
  ) {
    super();
    this.resolvedUrl = resolveImageSrc(source);
  }

  get estimatedHeight(): number {
    return imageSizes.get(this.resolvedUrl || this.source)?.height ?? 200;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-md-image-wrapper';

    const cachedSize = this.resolvedUrl ? imageSizes.get(this.resolvedUrl) : undefined;
    wrapper.style.cssText = cachedSize ? `height: ${cachedSize.height}px;` : 'min-height: 200px;';

    const image = document.createElement('img');
    image.alt = this.alt;
    image.className = 'cm-md-image-widget';
    if (this.resolvedUrl) image.src = this.resolvedUrl;
    if (cachedSize) {
      image.width = cachedSize.width;
      image.height = cachedSize.height;
    }

    image.onload = () => {
      const cacheKey = this.resolvedUrl || this.source;
      if (!imageSizes.has(cacheKey)) {
        imageSizes.set(cacheKey, { width: image.offsetWidth, height: image.offsetHeight });
      }
      wrapper.style.cssText = `height: ${image.offsetHeight}px;`;
    };

    wrapper.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const position = Math.min(this.endPosition, view.state.doc.length);
      view.dispatch({ selection: { anchor: view.state.doc.lineAt(position).to } });
      view.focus();
    });
    wrapper.appendChild(image);
    return wrapper;
  }

  eq(other: ImageWidget): boolean {
    return other.source === this.source && other.resolvedUrl === this.resolvedUrl;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function isRemoteSource(source: string): boolean {
  return (
    source.startsWith('http://') || source.startsWith('https://') || source.startsWith('data:')
  );
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

/* Where the pictures of a note's images (pictureElements.ts) get what they load. A note keeps
 * every line in the page, so a picture is resolved and loaded only once it comes within a
 * screen of the pane (M5): a long note pays for the pictures someone scrolls to. What an
 * image's destination loads from is the shell's (`ImageUrls`: the vault's per-file URLs on
 * desktop, a remote image's own address), resolved for display only and never written to the
 * note. A picture that loads redraws the caret and the highlight beside it, and one above the
 * pane's top keeps the text the reader is on where it was;
 * each URL's drawn height is kept, so a picture drawn again (the note opened again) has its
 * room before it loads. A picture that will not load (its file missing, not yet
 * synced) is marked so it shows its label (desktopImages.css). One whose file the shell could
 * not find is asked for again when the URLs change; one that failed to load, when the note is
 * opened again. */
import { MISSING_PICTURE, PICTURE_CLASS, PICTURE_SOURCE, pictureOf } from './pictureElements';
import { scrollerOf } from './paneScroll';

/** How the shell resolves an image's destination to a URL the page can load
 *  ($features/images/vaultImageSrc). */
export interface ImageUrls {
  /** The URL for `destination`, or '' while it is not resolved. */
  resolve(destination: string): string;
  /** Ask for `destination`'s URL, `onChange` telling when it lands; answers false when it will
   *  not resolve (its file is not there). */
  request(destination: string): Promise<boolean>;
  /** Call `listener` whenever what destinations resolve to changes; returns the unsubscribe. */
  onChange(listener: () => void): () => void;
}

/** How far beyond the pane a picture is loaded, above and below. */
const NEAR_MARGIN = '100% 0px';

function isPicture(node: Node): node is HTMLImageElement {
  return node instanceof HTMLImageElement && node.classList.contains(PICTURE_CLASS);
}

/** The pictures in `node`, itself included. */
function picturesIn(node: Node): HTMLImageElement[] {
  if (isPicture(node)) return [node];
  if (!(node instanceof Element)) return [];
  return [...node.getElementsByClassName(PICTURE_CLASS)].filter(isPicture);
}

export class EditorPictures {
  /** Each loaded URL's drawn height, CSS px: a picture given that URL again keeps that room
   *  until it loads (a picture's width and height attributes would stretch it under its
   *  height limit). */
  private readonly heights = new Map<string, number>();
  /** The pictures that have come near the pane, which a change of URLs resolves again. */
  private readonly near = new Set<HTMLImageElement>();
  /** Each picture's height when it was given its URL, so a load above the pane knows how far
   *  it moved the text below it. */
  private readonly heightsBefore = new WeakMap<HTMLImageElement, number>();
  /** Made with the first picture: a note without images needs none. */
  private watcher: IntersectionObserver | null = null;
  private readonly drawn: MutationObserver;

  constructor(
    private readonly editor: HTMLElement,
    private readonly urls: ImageUrls | undefined,
    private readonly redraw: () => void,
  ) {
    this.drawn = new MutationObserver((records) => this.redrawn(records));
  }

  /** Watch the editor's pictures; returns the undo. */
  listen(): () => void {
    const editor = this.editor;
    this.drawn.observe(editor, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [PICTURE_SOURCE],
    });
    const settled = (event: Event) => {
      if (isPicture(event.target as Node)) this.settled(event.target as HTMLImageElement, event);
    };
    // A picture's load and error do not bubble: heard on the way down.
    editor.addEventListener('load', settled, true);
    editor.addEventListener('error', settled, true);
    const stopChanges = this.urls?.onChange(() => this.near.forEach((one) => this.resolve(one)));
    return () => {
      stopChanges?.();
      editor.removeEventListener('load', settled, true);
      editor.removeEventListener('error', settled, true);
      this.drawn.disconnect();
      this.watcher?.disconnect();
      this.near.clear();
    };
  }

  /** The watch on how near the pane each picture is: the pane is its root, as the margin
   *  around a root that clips nothing would reach past the pane. */
  private watch(): IntersectionObserver {
    const scroller = scrollerOf(this.editor);
    return new IntersectionObserver((entries) => this.cameNear(entries), {
      root: scroller === document.documentElement ? null : scroller,
      rootMargin: NEAR_MARGIN,
    });
  }

  /** Pictures drawn, removed or given another image: watch the new, forget the gone. */
  private redrawn(records: readonly MutationRecord[]): void {
    for (const record of records) {
      if (record.type === 'attributes') {
        const picture = record.target as HTMLImageElement;
        picture.removeAttribute('src');
        picture.parentElement?.removeAttribute(MISSING_PICTURE);
        if (this.near.has(picture)) this.resolve(picture);
        continue;
      }
      for (const node of record.removedNodes) {
        for (const picture of picturesIn(node)) {
          if (picture.parentElement) this.watcher?.unobserve(picture.parentElement);
          this.near.delete(picture);
        }
      }
      for (const node of record.addedNodes) {
        for (const picture of picturesIn(node)) {
          this.watcher ??= this.watch();
          // Its element, not the picture: a picture with nothing to load draws nothing.
          this.watcher.observe(picture.parentElement!);
        }
      }
    }
  }

  private cameNear(entries: readonly IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const picture = pictureOf(entry.target);
      if (!picture || !entry.isIntersecting || this.near.has(picture)) continue;
      if (!picture.isConnected) continue;
      this.near.add(picture);
      this.resolve(picture);
    }
  }

  /** Give `picture` its URL, and its size where that URL loaded before; ask for it when it is
   *  not resolved yet. */
  private resolve(picture: HTMLImageElement): void {
    const destination = picture.getAttribute(PICTURE_SOURCE) ?? '';
    const url = this.urls?.resolve(destination) ?? '';
    if (!url) {
      void this.urls?.request(destination).then((resolved) => {
        if (resolved || !picture.isConnected || picture.hasAttribute('src')) return;
        picture.parentElement!.setAttribute(MISSING_PICTURE, '');
        this.redraw();
      });
      return;
    }
    if (picture.getAttribute('src') === url) return;
    const atom = picture.parentElement!;
    const height = this.heights.get(url);
    atom.style.minHeight = height ? `${height}px` : '';
    this.heightsBefore.set(picture, atom.getBoundingClientRect().height);
    picture.src = url;
  }

  /** A picture loaded, or will not: keep its height, mark a failure, hold the reader's text
   *  still and redraw what is drawn over the text. */
  private settled(picture: HTMLImageElement, event: Event): void {
    const failed = event.type === 'error';
    const atom = picture.parentElement!;
    atom.style.minHeight = '';
    if (failed) atom.setAttribute(MISSING_PICTURE, '');
    else {
      atom.removeAttribute(MISSING_PICTURE);
      this.heights.set(picture.getAttribute('src')!, picture.getBoundingClientRect().height);
    }
    this.keepReaderStill(picture);
    this.redraw();
  }

  /** A picture above the pane's top that changed height moved the text below it: scroll by as
   *  much. An engine that anchors its scroll itself (Chromium's `overflow-anchor`) already has. */
  private keepReaderStill(picture: HTMLImageElement): void {
    const before = this.heightsBefore.get(picture);
    this.heightsBefore.delete(picture);
    if (before === undefined || CSS.supports?.('overflow-anchor', 'auto')) return;
    const scroller = scrollerOf(this.editor);
    const box = picture.parentElement!.getBoundingClientRect();
    if (box.top >= scroller.getBoundingClientRect().top) return;
    scroller.scrollTop += box.height - before;
  }
}

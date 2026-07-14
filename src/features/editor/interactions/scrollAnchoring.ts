import type { Extension } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';

import { warmHeightMap } from '../heightMapWarm';

export class EditorScrollAnchoring {
  private view: EditorView | null = null;
  private scrollParent: HTMLElement | null = null;
  private anchorPosition = -1;
  private anchorBlockTop = 0;
  private isCompensating = false;
  private isUserScrolling = false;
  private scrollTimer: number | null = null;
  private warmAnimationFrame = 0;
  private resizeObserver: ResizeObserver | null = null;

  readonly extension: Extension;

  constructor(private readonly codeMirrorOwnsScroller: boolean) {
    this.extension = EditorView.updateListener.of((update) => this.handleUpdate(update));
  }

  attachView(view: EditorView): void {
    this.view = view;
    this.resetAnchor();
    if (!this.codeMirrorOwnsScroller) return;

    this.scheduleWarm();
    let lastWidth = view.scrollDOM.clientWidth;
    this.resizeObserver = new ResizeObserver(() => {
      const width = view.scrollDOM.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      this.scheduleWarm();
    });
    this.resizeObserver.observe(view.scrollDOM);
  }

  connectScrollParent(parent: HTMLElement | null): () => void {
    this.disconnectScrollParent();
    this.scrollParent = parent;
    if (parent) parent.addEventListener('scroll', this.handleScroll, { passive: true });

    return () => {
      if (this.scrollParent === parent) this.disconnectScrollParent();
    };
  }

  resetAnchor(): void {
    this.anchorPosition = -1;
    this.anchorBlockTop = 0;
    this.isCompensating = false;
  }

  scheduleWarm(): void {
    if (!this.codeMirrorOwnsScroller || this.warmAnimationFrame) return;
    if (
      typeof window !== 'undefined' &&
      (window as { __futoDisableScrollWarm?: boolean }).__futoDisableScrollWarm
    ) {
      return;
    }

    this.warmAnimationFrame = requestAnimationFrame(() => {
      this.warmAnimationFrame = 0;
      if (this.view) warmHeightMap(this.view);
    });
  }

  warmNow(): { grew: number; steps: number } | null {
    return this.view ? warmHeightMap(this.view) : null;
  }

  destroy(): void {
    this.disconnectScrollParent();
    if (this.warmAnimationFrame) cancelAnimationFrame(this.warmAnimationFrame);
    this.warmAnimationFrame = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.view = null;
  }

  private readonly handleScroll = (): void => {
    this.isUserScrolling = true;
    if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
    this.scrollTimer = window.setTimeout(() => {
      this.isUserScrolling = false;
      this.scrollTimer = null;
    }, 150);
    if (this.view) this.updateAnchor(this.view);
  };

  private handleUpdate(update: ViewUpdate): void {
    const parent = this.scrollParent;
    if (!parent) return;

    if (
      update.heightChanged &&
      !update.docChanged &&
      !this.isUserScrolling &&
      this.anchorPosition >= 0 &&
      this.anchorPosition <= update.state.doc.length
    ) {
      try {
        const block = update.view.lineBlockAt(this.anchorPosition);
        const delta = block.top - this.anchorBlockTop;
        if (Math.abs(delta) > 0.5) {
          this.isCompensating = true;
          parent.scrollTop += delta;
          this.anchorBlockTop = block.top;
          requestAnimationFrame(() => {
            this.isCompensating = false;
          });
        }
      } catch {
        this.anchorPosition = -1;
      }
    }

    this.updateAnchor(update.view);
  }

  private updateAnchor(view: EditorView): void {
    const parent = this.scrollParent;
    if (!parent || this.isCompensating) return;
    const viewportTop = parent.getBoundingClientRect().top - view.dom.getBoundingClientRect().top;
    if (viewportTop <= 0) {
      this.anchorPosition = -1;
      return;
    }

    try {
      const block = view.lineBlockAtHeight(viewportTop);
      this.anchorPosition = block.from;
      this.anchorBlockTop = block.top;
    } catch {
      this.anchorPosition = -1;
    }
  }

  private disconnectScrollParent(): void {
    this.scrollParent?.removeEventListener('scroll', this.handleScroll);
    this.scrollParent = null;
    if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
    this.scrollTimer = null;
    this.isUserScrolling = false;
  }
}

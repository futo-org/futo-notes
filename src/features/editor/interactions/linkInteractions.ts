import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { findUrlAtPosition } from '../links/autolinks';

const EXTERNAL_LINK_SELECTOR = '.cm-md-link:not(.cm-md-wikilink)';

interface LinkInteractionCallbacks {
  openWikilink: (title: string, event: MouseEvent) => void;
  openExternalUrl: (url: string) => void;
}

function findExternalLinkElementAtPoint(
  target: Element | null,
  x: number,
  y: number,
): Element | null {
  const line = target?.closest('.cm-line');
  if (!line) return null;

  for (const candidate of line.querySelectorAll(EXTERNAL_LINK_SELECTOR)) {
    const rect = candidate.getBoundingClientRect();
    if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) {
      return candidate;
    }
  }
  return null;
}

function resolveLinkUrl(view: EditorView, link: Element): string | null {
  try {
    const start = view.posAtDOM(link, 0);
    const end = view.posAtDOM(link, link.childNodes.length);
    return findUrlAtPosition(view, Math.floor((start + end) / 2));
  } catch {
    return null;
  }
}

export class EditorLinkInteractions {
  private wikilinkTouch: { x: number; y: number } | null = null;
  private externalLinkTouch: { x: number; y: number } | null = null;
  private pendingLinkUrl: string | null = null;

  readonly extensions: Extension[];

  constructor(private readonly callbacks: LinkInteractionCallbacks) {
    this.extensions = [this.createWikilinkHandler(), this.createExternalLinkHandler()];
  }

  get hasPendingExternalLink(): boolean {
    return this.pendingLinkUrl !== null;
  }

  private createWikilinkHandler(): Extension {
    return EditorView.domEventHandlers({
      touchstart: (event) => {
        const target = event.target as HTMLElement | null;
        const touch = event.touches[0];
        this.wikilinkTouch =
          target?.closest('.cm-md-wikilink') && touch
            ? { x: touch.clientX, y: touch.clientY }
            : null;
        return false;
      },
      touchend: (event) => {
        const start = this.wikilinkTouch;
        this.wikilinkTouch = null;
        const touch = event.changedTouches[0];
        if (!start || !touch || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 8) {
          return false;
        }

        const wikilink = (event.target as HTMLElement | null)?.closest(
          '.cm-md-wikilink',
        ) as HTMLElement | null;
        const title = wikilink?.getAttribute('data-wikilink');
        if (!title) return false;
        event.preventDefault();
        event.stopPropagation();
        this.callbacks.openWikilink(title, event as unknown as MouseEvent);
        return true;
      },
      mousedown: (event) => {
        if (!(event.target as HTMLElement | null)?.closest('.cm-md-wikilink')) return false;
        event.preventDefault();
        return true;
      },
      click: (event) => this.openWikilinkFromMouseEvent(event),
      auxclick: (event) => {
        if (event.button !== 1) return false;
        return this.openWikilinkFromMouseEvent(event);
      },
    });
  }

  private openWikilinkFromMouseEvent(event: MouseEvent): boolean {
    const wikilink = (event.target as HTMLElement | null)?.closest(
      '.cm-md-wikilink',
    ) as HTMLElement | null;
    const title = wikilink?.getAttribute('data-wikilink');
    if (!title) return false;
    event.preventDefault();
    event.stopPropagation();
    this.callbacks.openWikilink(title, event);
    return true;
  }

  private createExternalLinkHandler(): Extension {
    return EditorView.domEventHandlers({
      touchstart: (event) => {
        const target = event.target as HTMLElement | null;
        const touch = event.touches[0];
        this.externalLinkTouch =
          target?.closest(EXTERNAL_LINK_SELECTOR) && !target.closest('.cm-md-wikilink') && touch
            ? { x: touch.clientX, y: touch.clientY }
            : null;
        return false;
      },
      touchend: (event, view) => {
        const start = this.externalLinkTouch;
        this.externalLinkTouch = null;
        const touch = event.changedTouches[0];
        if (!start || !touch || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 8) {
          return false;
        }

        const target = event.target as HTMLElement | null;
        const hit = document.elementFromPoint(touch.clientX, touch.clientY);
        const link =
          findExternalLinkElementAtPoint(hit, touch.clientX, touch.clientY) ??
          findExternalLinkElementAtPoint(target, touch.clientX, touch.clientY) ??
          hit?.closest(EXTERNAL_LINK_SELECTOR) ??
          target?.closest(EXTERNAL_LINK_SELECTOR);
        if (!link || link.closest('.cm-md-wikilink')) return false;
        const url = resolveLinkUrl(view, link);
        if (!url) return false;
        event.preventDefault();
        event.stopPropagation();
        this.callbacks.openExternalUrl(url);
        return true;
      },
      mousedown: (event, view) => {
        this.pendingLinkUrl = null;
        const targetNode = event.target as Node | null;
        const target =
          targetNode instanceof Element ? targetNode : (targetNode?.parentElement ?? null);
        if (target?.closest('a.cm-md-table-link')) return false;

        const hit = document.elementFromPoint(event.clientX, event.clientY);
        const link =
          findExternalLinkElementAtPoint(hit, event.clientX, event.clientY) ??
          findExternalLinkElementAtPoint(target, event.clientX, event.clientY) ??
          hit?.closest(EXTERNAL_LINK_SELECTOR) ??
          target?.closest(EXTERNAL_LINK_SELECTOR);
        if (!link) return false;
        const url = resolveLinkUrl(view, link);
        if (!url) return false;
        this.pendingLinkUrl = url;
        event.preventDefault();
        return true;
      },
      click: (event) => {
        const url = this.pendingLinkUrl;
        this.pendingLinkUrl = null;
        if (!url) return false;
        event.preventDefault();
        event.stopPropagation();
        this.callbacks.openExternalUrl(url);
        return true;
      },
    });
  }
}

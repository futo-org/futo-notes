/*
 * Link taps: how a tap or click on a link in the editor reaches the host.
 *
 * Wikilinks and external links share ONE activation path on purpose. The
 * reason they need a `touchend` leg at all is engine-specific and applies to
 * both: on iOS WebKit a prevented mousedown cancels the synthetic click, so a
 * click-only handler dead-ends there while Chromium double-fires
 * (docs/spec/editor.md, "Wikilinks — navigation & integrity"). Splitting the
 * two would have left external links on the leg that dead-ends.
 */
import type { EditorLinkGesture } from '../editorLinkGesture';
import { DEFAULT_LONG_PRESS_MS } from './mobileBlockDnd';
import { WIKILINK_TARGET_ATTR } from './wikilink';
import { WIKILINK_BROKEN_CLASS } from './wikilink/display';

type EditorLink =
  { kind: 'wikilink'; title: string; broken: boolean } | { kind: 'external'; url: string };

/** A wikilink chip is an anchor carrying the raw target; anything else with
 * an href leaves the app. Neither is a plain caret placement. */
function linkAt(node: HTMLElement | null): EditorLink | null {
  const anchor = node?.closest('a');
  if (!anchor) return null;
  const title = anchor.getAttribute(WIKILINK_TARGET_ATTR);
  if (title !== null) {
    return { kind: 'wikilink', title, broken: anchor.classList.contains(WIKILINK_BROKEN_CLASS) };
  }
  const href = anchor.getAttribute('href') ?? '';
  return href ? { kind: 'external', url: href } : null;
}

/**
 * A tap on a BROKEN wikilink must not be swallowed. The host may do nothing
 * with it — the native embed posts `openNote` only for a resolved link, a
 * known limitation — and preventing the default as well would leave a dead
 * chip that can be neither followed nor repaired, since an atom node is
 * fixed by SELECTING and replacing it, not by editing inside it. Letting
 * ProseMirror have the event keeps the spec's intent ("a broken wikilink
 * still focuses, so it can be edited") reachable in the WYSIWYG model.
 */
function consumesTap(link: EditorLink): boolean {
  return !(link.kind === 'wikilink' && link.broken);
}

const NEUTRAL_GESTURE: EditorLinkGesture = {
  button: 0,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

const SYNTHETIC_CLICK_WINDOW_MS = 700;
const TAP_MOVE_PX = 10;

/** The component props a link tap reports through. Getters: each read is the CURRENT prop. */
export interface LinkTapProps {
  readonly onopenlink?: (title: string, gesture: EditorLinkGesture) => void;
  readonly onopenurl?: (url: string) => void;
}

export interface LinkTapDeps {
  props: LinkTapProps;
  /** The block-drag gate (MilkdownEditor.svelte): no ⠿ handle to surface under the long-press path. */
  useMobileBlockDnd: () => boolean;
  nudgeBlockHandle: (clientY: number) => void;
}

/** The container listeners for one editor's link taps, and the touch they are tracking. */
export function createLinkTaps(deps: LinkTapDeps) {
  const { props, useMobileBlockDnd, nudgeBlockHandle } = deps;

  /* A WebView can emit a click after touchend despite preventDefault. Remember
   * only that touch's anchor; independent mouse clicks must still open links. */
  let pendingTouchClick: { anchor: HTMLAnchorElement; at: number } | null = null;
  let linkTouch: {
    identifier: number;
    x: number;
    y: number;
    at: number;
    anchor: HTMLAnchorElement;
    moved: boolean;
  } | null = null;
  function activateLink(link: EditorLink, gesture: EditorLinkGesture): void {
    /* Broken links are posted too: what happens next is the HOST's call —
     * desktop opens an empty editor bound to the target text, the native embed
     * drops it. The editor does not resolve here. */
    if (link.kind === 'wikilink') props.onopenlink?.(link.title, gesture);
    else props.onopenurl?.(link.url);
  }

  function handleTouchStart(event: TouchEvent): void {
    linkTouch = null;
    if (event.touches.length !== 1) return;
    const anchor = (event.target as HTMLElement | null)?.closest('a');
    const touch = event.changedTouches[0];
    if (!anchor || !touch || !linkAt(anchor)) return;
    linkTouch = {
      identifier: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      at: Date.now(),
      anchor,
      moved: false,
    };
  }

  function handleTouchMove(event: TouchEvent): void {
    if (!linkTouch) return;
    const touch = Array.from(event.touches).find(
      (candidate) => candidate.identifier === linkTouch?.identifier,
    );
    if (
      !touch ||
      event.touches.length !== 1 ||
      Math.hypot(touch.clientX - linkTouch.x, touch.clientY - linkTouch.y) > TAP_MOVE_PX
    ) {
      linkTouch.moved = true;
    }
  }

  function handleTouchCancel(): void {
    linkTouch = null;
  }

  function handlePointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse') pendingTouchClick = null;
  }

  function handleTouchEnd(event: TouchEvent): void {
    const started = linkTouch;
    linkTouch = null;
    const touch = Array.from(event.changedTouches).find(
      (candidate) => candidate.identifier === started?.identifier,
    );
    // A rejected hold can still produce a compatibility click on release.
    if (started && touch) pendingTouchClick = { anchor: started.anchor, at: Date.now() };
    if (
      !started ||
      !touch ||
      event.touches.length !== 0 ||
      started.moved ||
      Date.now() - started.at >= DEFAULT_LONG_PRESS_MS ||
      Math.hypot(touch.clientX - started.x, touch.clientY - started.y) > TAP_MOVE_PX ||
      !(event.target as HTMLElement | null)?.closest('a')?.isSameNode(started.anchor)
    )
      return;
    const link = linkAt(started.anchor);
    if (!link) return;
    // Also stops WebKit turning the tap into a caret placement inside the chip.
    if (consumesTap(link)) event.preventDefault();
    activateLink(link, NEUTRAL_GESTURE);
  }

  /* Task checkboxes own their own taps — see taskCheckbox.ts, whose widget
   * both draws the box and toggles it. This handler is only links and the
   * tap-to-surface-the-drag-handle behavior. */
  function handleClick(event: MouseEvent): void {
    if (event.button !== 0) return;
    handleLinkClick(event);
  }

  function handleAuxClick(event: MouseEvent): void {
    if (event.button === 1) handleLinkClick(event);
  }

  function handleLinkClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // BlockService already owns mousedown/dragstart on its own handle DOM.
    if (target.closest('.milkdown-block-handle')) return;

    const link = linkAt(target);
    if (link) {
      if (consumesTap(link)) event.preventDefault();
      const anchor = target.closest('a');
      const touchClick = pendingTouchClick;
      pendingTouchClick = null;
      if (
        event.button === 0 &&
        event.detail !== 0 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        touchClick?.anchor === anchor &&
        Date.now() - touchClick.at <= SYNTHETIC_CLICK_WINDOW_MS &&
        (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } })
          .sourceCapabilities?.firesTouchEvents !== false
      )
        return;
      activateLink(link, {
        button: event.button === 1 ? 1 : 0,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      });
      return;
    }

    // No hover on mobile — surface the drag handle for whatever block was
    // tapped. Not applicable under the long-press path (no handle).
    if (!useMobileBlockDnd()) nudgeBlockHandle(event.clientY);
  }

  return {
    handleClick,
    handleAuxClick,
    handlePointerDown,
    handleTouchStart,
    handleTouchMove,
    handleTouchCancel,
    handleTouchEnd,
  };
}

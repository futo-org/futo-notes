import { EditorSelection, type Extension, type SelectionRange, type Text } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

import {
  clearMarkdownSelectionReveal,
  createSelectionRevealSnapshot,
  freezeMarkdownSelectionReveal,
  markdownSelectionRevealState,
  suppressMarkdownSelectionReveal,
} from '../live-preview/selectionReveal';
import { liveMarkdownRefresh } from '../live-preview/refreshEffect';
import {
  getRenderedRowRight,
  lineHitAtPoint,
  lineHitBesidePoint,
  pointerTargetIsInteractive,
  positionBelowText,
  resolvePointerLinkAtPoint,
  resolveTapPositionAt,
  rowEndSelectionAt,
  type PointerLinkHit,
} from './pointerHitTest';
import { snapSelectionPastMarkdownMarkers } from './selectionSnap';

const DRAG_DISTANCE_SQUARED = 9;
const TOUCH_TAP_DISTANCE = 8;
const IOS_MULTI_TAP_DISTANCE = 32;
const IOS_MULTI_TAP_INTERVAL_MS = 400;

/** Selects the browser-engine pointer policy once for an editor view's lifetime. */
export type EditorPointerProfile = 'desktop' | 'browser-ios' | 'native-ios' | 'native-android';

/** Navigation-relevant facts captured from one editor link gesture. */
export interface EditorLinkGesture {
  readonly button: 0 | 1;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/** A semantic editor link target independent of its transient decorated DOM. */
export type EditorLinkTarget =
  { kind: 'wikilink'; title: string } | { kind: 'external'; url: string };

/** One editor link activation delivered after internal gesture arbitration. */
export interface EditorLinkActivation {
  readonly target: EditorLinkTarget;
  readonly gesture: EditorLinkGesture;
}

/** Host policy and semantic outputs required by editorPointerInteractions. */
export interface EditorPointerInteractionOptions {
  profile: EditorPointerProfile;
  activateLink: (activation: EditorLinkActivation) => void;
  onWindowBlur: () => void;
}

interface PointerPoint {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}

type PendingClick =
  | { kind: 'none' }
  | { kind: 'link'; target: EditorLinkTarget; press: PointerPoint }
  | { kind: 'consume-placement' };

interface IosOffTextTapSequence {
  document: Text;
  point: PointerPoint;
  timeStamp: number;
  tapCount: 1 | 2;
}

function usesDesktopPointerPolicy(profile: EditorPointerProfile): boolean {
  return profile === 'desktop' || profile === 'browser-ios';
}

function usesIosTouchPolicy(profile: EditorPointerProfile): boolean {
  return profile === 'browser-ios' || profile === 'native-ios';
}

function isModified(event: MouseEvent): boolean {
  return event.shiftKey || event.altKey || event.metaKey || event.ctrlKey;
}

function mouseLinkGesture(event: MouseEvent): EditorLinkGesture {
  return {
    button: event.button === 1 ? 1 : 0,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  };
}

function touchLinkGesture(): EditorLinkGesture {
  return { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
}

function pointFromTouchList(touches: TouchList): PointerPoint | null {
  const touch = touches[0];
  return touch ? { clientX: touch.clientX, clientY: touch.clientY, target: touch.target } : null;
}

function pointsAreNear(left: PointerPoint, right: PointerPoint, distance: number): boolean {
  return Math.hypot(left.clientX - right.clientX, left.clientY - right.clientY) <= distance;
}

function focusEditorWithoutScroll(view: EditorView): void {
  try {
    view.contentDOM.focus({ preventScroll: true });
  } catch {
    view.contentDOM.focus();
  }
  if (!view.hasFocus) view.contentDOM.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
}

function resolveOffTextCaretAt(view: EditorView, point: PointerPoint): SelectionRange | null {
  const below = positionBelowText(point.clientX, point.clientY, view);
  if (below) return below;

  const hit = lineHitBesidePoint(point.clientX, point.clientY, view, point.target as Node | null);
  if (!hit) return null;
  const visibleRight = getRenderedRowRight(hit.lineElement, point.clientY);
  if (visibleRight === null || point.clientX <= visibleRight + 1) return null;
  return rowEndSelectionAt(point.clientY, hit, view);
}

function wordSelectionAtResolvedCaret(view: EditorView, caret: SelectionRange): SelectionRange {
  const word = view.state.wordAt(caret.head);
  if (word || caret.head !== view.state.doc.length) return word ?? caret;

  for (let position = caret.head - 1; position >= 0; position--) {
    const precedingWord = view.state.wordAt(position);
    if (precedingWord) return precedingWord;
  }
  return caret;
}

function paragraphSelectionAtResolvedCaret(
  view: EditorView,
  caret: SelectionRange,
): SelectionRange {
  let line = view.state.doc.lineAt(caret.head);
  while (line.number > 1 && line.text.trim().length === 0) {
    line = view.state.doc.line(line.number - 1);
  }
  return EditorSelection.range(line.from, line.to);
}

function desktopOffTextSelection(): Extension {
  return EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button !== 0 || event.detail > 2 || isModified(event)) return null;
    const pressed = resolveOffTextCaretAt(view, event);
    if (!pressed) return null;

    const byWord = event.detail === 2;
    const spanAt = (at: number): SelectionRange =>
      (byWord ? view.state.wordAt(at) : null) ?? EditorSelection.cursor(at);
    let anchor: SelectionRange = pressed;
    let from = spanAt(anchor.head);

    return {
      get: (currentEvent) => {
        const head =
          resolveOffTextCaretAt(view, currentEvent)?.head ??
          view.posAtCoords({ x: currentEvent.clientX, y: currentEvent.clientY }, false);
        if (!byWord && head === anchor.head) return EditorSelection.create([anchor]);
        const to = spanAt(head);
        return head < from.from
          ? EditorSelection.single(from.to, to.from)
          : EditorSelection.single(from.from, to.to);
      },
      update: (update) => {
        if (!update.docChanged) return false;
        anchor = anchor.map(update.changes);
        from = from.map(update.changes);
        return false;
      },
    };
  });
}

class EditorPointerController {
  readonly handlesTouchAtScroller: boolean;
  private pendingClick: PendingClick = { kind: 'none' };
  private touchStart: PointerPoint | null = null;
  private touchStartedLink: PointerLinkHit | null = null;
  private touchMoved = false;
  private previousIosOffTextTap: IosOffTextTapSequence | null = null;
  private nativeOffTextPressDocument: Text | null = null;
  private desktopPress: { x: number; y: number } | null = null;
  private desktopDragging = false;
  private selectionSettleTimer: number | null = null;
  private lineSelectionTimer: number | null = null;
  private readonly ownerWindow: Window;

  constructor(
    private readonly view: EditorView,
    private readonly options: EditorPointerInteractionOptions,
  ) {
    this.ownerWindow = view.dom.ownerDocument.defaultView ?? window;
    this.handlesTouchAtScroller = usesIosTouchPolicy(options.profile);
    if (this.handlesTouchAtScroller) {
      view.scrollDOM.addEventListener('touchstart', this.handleTouchStart, {
        passive: true,
      });
      view.scrollDOM.addEventListener('touchmove', this.handleTouchMove, { passive: true });
      view.scrollDOM.addEventListener('touchend', this.handleTouchEnd, { passive: false });
      view.scrollDOM.addEventListener('touchcancel', this.handleTouchCancel, {
        passive: true,
      });
    }
    if (!usesDesktopPointerPolicy(options.profile)) return;
    view.dom.addEventListener('mousedown', this.handleDesktopPress, true);
    this.ownerWindow.addEventListener('mousemove', this.handleDesktopMove, true);
    this.ownerWindow.addEventListener('mouseup', this.handleDesktopRelease, true);
    this.ownerWindow.addEventListener('blur', this.handleDesktopWindowBlur);
  }

  handleTouchStart = (event: TouchEvent): boolean => {
    this.pendingClick = { kind: 'none' };
    if (event.touches.length !== 1) {
      this.clearNativeTapHistory();
    }
    this.touchStart = event.touches.length === 1 ? pointFromTouchList(event.touches) : null;
    this.touchStartedLink =
      this.touchStart &&
      resolvePointerLinkAtPoint(
        this.view,
        this.touchStart.target,
        this.touchStart.clientX,
        this.touchStart.clientY,
      );
    this.touchMoved = false;
    return false;
  };

  handleTouchMove = (event: TouchEvent): boolean => {
    if (!this.touchStart) return false;
    if (event.touches.length !== 1) {
      this.clearNativeTapHistory();
      this.resetTouchGesture();
      return false;
    }
    const current = pointFromTouchList(event.touches);
    if (current && !pointsAreNear(this.touchStart, current, TOUCH_TAP_DISTANCE)) {
      this.touchMoved = true;
      this.clearNativeTapHistory();
    }
    return false;
  };

  handleTouchEnd = (event: TouchEvent): boolean => {
    const start = this.touchStart;
    const startedLink = this.touchStartedLink;
    const end = pointFromTouchList(event.changedTouches);
    const isTap =
      event.changedTouches.length === 1 &&
      start &&
      end &&
      !this.touchMoved &&
      pointsAreNear(start, end, TOUCH_TAP_DISTANCE);
    this.resetTouchGesture();
    if (!isTap) {
      this.clearNativeTapHistory();
    }
    if (!isTap || !end) return false;
    if (pointerTargetIsInteractive(end.target)) {
      this.clearNativeTapHistory();
      return false;
    }

    const link =
      resolvePointerLinkAtPoint(this.view, end.target, end.clientX, end.clientY) ?? startedLink;
    const brokenFirstIosWikilink =
      usesIosTouchPolicy(this.options.profile) &&
      !this.view.hasFocus &&
      link?.kind === 'wikilink' &&
      link.broken;
    if (startedLink && link && !brokenFirstIosWikilink) {
      this.previousIosOffTextTap = null;
      event.preventDefault();
      event.stopPropagation();
      this.activateLink(
        link.kind === 'wikilink'
          ? { kind: 'wikilink', title: link.title }
          : { kind: 'external', url: link.url },
        touchLinkGesture(),
      );
      return true;
    }

    if (usesIosTouchPolicy(this.options.profile)) {
      const offTextCaret = resolveOffTextCaretAt(this.view, end);
      if (offTextCaret) {
        const tapCount = this.advanceIosOffTextTapSequence(end, event.timeStamp);
        this.nativeOffTextPressDocument = null;
        event.preventDefault();
        if (!this.view.hasFocus) focusEditorWithoutScroll(this.view);
        const selection =
          tapCount === 3
            ? paragraphSelectionAtResolvedCaret(this.view, offTextCaret)
            : tapCount === 2
              ? wordSelectionAtResolvedCaret(this.view, offTextCaret)
              : offTextCaret;
        this.view.dispatch({
          selection: EditorSelection.create([selection]),
          scrollIntoView: false,
        });
        return true;
      }
      this.previousIosOffTextTap = null;
    }

    if (!usesIosTouchPolicy(this.options.profile) || this.view.hasFocus) return false;
    const caret = resolveTapPositionAt(
      end.clientX,
      end.clientY,
      this.view,
      end.target instanceof Node ? end.target : null,
    );
    if (!caret) return false;

    event.preventDefault();
    focusEditorWithoutScroll(this.view);
    this.view.dispatch({ selection: EditorSelection.create([caret]), scrollIntoView: false });
    return true;
  };

  handleTouchCancel = (): boolean => {
    this.clearNativeTapHistory();
    this.resetTouchGesture();
    return false;
  };

  handleMouseDown(event: MouseEvent): boolean {
    this.pendingClick = { kind: 'none' };
    if (!usesDesktopPointerPolicy(this.options.profile) && event.detail === 1) {
      this.nativeOffTextPressDocument = null;
    }

    if (this.shouldSelectTripleClickedLine(event)) return true;

    if (!pointerTargetIsInteractive(event.target)) {
      const link = resolvePointerLinkAtPoint(this.view, event.target, event.clientX, event.clientY);
      if (link) {
        event.preventDefault();
        if (event.button === 0) {
          this.pendingClick = {
            kind: 'link',
            target:
              link.kind === 'wikilink'
                ? { kind: 'wikilink', title: link.title }
                : { kind: 'external', url: link.url },
            press: {
              clientX: event.clientX,
              clientY: event.clientY,
              target: event.target,
            },
          };
        }
        return true;
      }
    }

    if (usesDesktopPointerPolicy(this.options.profile)) return this.guardHiddenOnlyNote(event);
    if (event.button !== 0 || (event.detail !== 1 && event.detail !== 2) || isModified(event)) {
      return false;
    }
    const caret = resolveOffTextCaretAt(this.view, event);
    if (!caret) return false;

    const selectsWord =
      event.detail === 2 && this.nativeOffTextPressDocument === this.view.state.doc;
    this.nativeOffTextPressDocument = event.detail === 1 ? this.view.state.doc : null;
    this.pendingClick = { kind: 'consume-placement' };
    event.preventDefault();
    this.view.focus();
    const selection = selectsWord ? wordSelectionAtResolvedCaret(this.view, caret) : caret;
    this.view.dispatch({ selection: EditorSelection.create([selection]) });
    return true;
  }

  handleClick(event: MouseEvent): boolean {
    const pendingClick = this.pendingClick;
    this.pendingClick = { kind: 'none' };
    if (pendingClick.kind === 'link') {
      const release = {
        clientX: event.clientX,
        clientY: event.clientY,
        target: event.target,
      };
      if (!pointsAreNear(pendingClick.press, release, TOUCH_TAP_DISTANCE)) return false;
      event.preventDefault();
      event.stopPropagation();
      this.activateLink(pendingClick.target, mouseLinkGesture(event));
      return true;
    }
    if (pendingClick.kind === 'consume-placement') {
      event.preventDefault();
      return true;
    }

    if (
      usesDesktopPointerPolicy(this.options.profile) &&
      this.shouldSelectTripleClickedLine(event)
    ) {
      return true;
    }
    if (
      this.options.profile !== 'native-android' ||
      event.button !== 0 ||
      event.detail !== 1 ||
      isModified(event)
    ) {
      return false;
    }

    const selection = this.view.state.selection.main;
    if (!selection.empty) return false;
    const caret = resolveTapPositionAt(
      event.clientX,
      event.clientY,
      this.view,
      event.target as Node | null,
    );
    if (!caret || caret.head === selection.head) return false;
    this.view.dispatch({ selection: EditorSelection.create([caret]), scrollIntoView: false });
    return false;
  }

  handleAuxClick(event: MouseEvent): boolean {
    if (event.button !== 1) return false;
    const link = resolvePointerLinkAtPoint(this.view, event.target, event.clientX, event.clientY);
    if (link?.kind !== 'wikilink') return false;
    event.preventDefault();
    event.stopPropagation();
    this.activateLink({ kind: 'wikilink', title: link.title }, mouseLinkGesture(event));
    return true;
  }

  destroy(): void {
    if (this.handlesTouchAtScroller) {
      this.view.scrollDOM.removeEventListener('touchstart', this.handleTouchStart);
      this.view.scrollDOM.removeEventListener('touchmove', this.handleTouchMove);
      this.view.scrollDOM.removeEventListener('touchend', this.handleTouchEnd);
      this.view.scrollDOM.removeEventListener('touchcancel', this.handleTouchCancel);
    }
    if (usesDesktopPointerPolicy(this.options.profile)) {
      this.view.dom.removeEventListener('mousedown', this.handleDesktopPress, true);
      this.ownerWindow.removeEventListener('mousemove', this.handleDesktopMove, true);
      this.ownerWindow.removeEventListener('mouseup', this.handleDesktopRelease, true);
      this.ownerWindow.removeEventListener('blur', this.handleDesktopWindowBlur);
    }
    this.clearTimer('selection');
    this.clearTimer('line');
    this.pendingClick = { kind: 'none' };
    this.clearNativeTapHistory();
    this.resetTouchGesture();
    this.view.dom.removeAttribute('data-selection-reveal-suppressed');
  }

  private activateLink(target: EditorLinkTarget, gesture: EditorLinkGesture): void {
    this.pendingClick = { kind: 'none' };
    this.options.activateLink({ target, gesture });
  }

  private shouldSelectTripleClickedLine(event: MouseEvent): boolean {
    if (
      !usesDesktopPointerPolicy(this.options.profile) ||
      event.button !== 0 ||
      event.detail !== 3
    ) {
      return false;
    }
    const hit = lineHitAtPoint(
      event.clientX,
      event.clientY,
      this.view,
      event.target as Node | null,
    );
    if (!hit) return false;

    event.preventDefault();
    event.stopPropagation();
    this.view.focus();
    this.clearTimer('line');
    this.lineSelectionTimer = this.ownerWindow.setTimeout(() => {
      this.lineSelectionTimer = null;
      this.view.dispatch({ selection: { anchor: hit.line.from, head: hit.line.to } });
    }, 0);
    return true;
  }

  private guardHiddenOnlyNote(event: MouseEvent): boolean {
    if (event.button !== 0) return false;
    const position = this.view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    if (this.view.coordsAtPos(position) !== null) return false;
    event.preventDefault();
    return true;
  }

  private readonly handleDesktopPress = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    this.desktopPress = { x: event.clientX, y: event.clientY };
    this.desktopDragging = false;
    this.view.dispatch({
      effects: [
        freezeMarkdownSelectionReveal.of({
          owner: 'pointer',
          snapshot: createSelectionRevealSnapshot(
            this.view.hasFocus,
            this.view.state.selection.ranges,
          ),
        }),
        suppressMarkdownSelectionReveal.of({ owner: 'pointer', suppressed: false }),
      ],
    });
  };

  private readonly handleDesktopMove = (event: MouseEvent): void => {
    if (!this.desktopPress || this.desktopDragging) return;
    const deltaX = event.clientX - this.desktopPress.x;
    const deltaY = event.clientY - this.desktopPress.y;
    if (deltaX * deltaX + deltaY * deltaY < DRAG_DISTANCE_SQUARED) return;
    this.desktopDragging = true;
    this.setSelectionRevealSuppressed(true);
  };

  private readonly handleDesktopRelease = (): void => {
    if (!this.desktopPress) return;
    const wasDragging = this.desktopDragging;
    this.desktopPress = null;
    this.desktopDragging = false;
    this.finishSelectionRevealGesture();
    this.clearTimer('selection');
    this.selectionSettleTimer = this.ownerWindow.setTimeout(() => {
      this.selectionSettleTimer = null;
      snapSelectionPastMarkdownMarkers(this.view, wasDragging);
    }, 0);
  };

  private readonly handleDesktopWindowBlur = (): void => {
    this.pendingClick = { kind: 'none' };
    this.desktopPress = null;
    this.desktopDragging = false;
    this.finishSelectionRevealGesture();
    this.clearTimer('selection');
    this.options.onWindowBlur();
  };

  private setSelectionRevealSuppressed(suppressed: boolean): void {
    this.view.dispatch({
      effects: suppressMarkdownSelectionReveal.of({ owner: 'pointer', suppressed }),
    });
    this.view.dom.toggleAttribute('data-selection-reveal-suppressed', suppressed);
  }

  private finishSelectionRevealGesture(): void {
    this.view.dispatch({
      effects: [
        clearMarkdownSelectionReveal.of('pointer'),
        suppressMarkdownSelectionReveal.of({ owner: 'pointer', suppressed: false }),
        liveMarkdownRefresh.of(null),
      ],
    });
    this.view.dom.removeAttribute('data-selection-reveal-suppressed');
  }

  private clearTimer(timer: 'selection' | 'line'): void {
    const value = timer === 'selection' ? this.selectionSettleTimer : this.lineSelectionTimer;
    if (value === null) return;
    this.ownerWindow.clearTimeout(value);
    if (timer === 'selection') this.selectionSettleTimer = null;
    else this.lineSelectionTimer = null;
  }

  private clearNativeTapHistory(): void {
    this.previousIosOffTextTap = null;
    this.nativeOffTextPressDocument = null;
  }

  private advanceIosOffTextTapSequence(point: PointerPoint, timeStamp: number): 1 | 2 | 3 {
    const previous = this.previousIosOffTextTap;
    const elapsed = previous ? timeStamp - previous.timeStamp : Number.POSITIVE_INFINITY;
    const continuesTapSequence =
      previous !== null &&
      previous.document === this.view.state.doc &&
      elapsed >= 0 &&
      elapsed <= IOS_MULTI_TAP_INTERVAL_MS &&
      pointsAreNear(previous.point, point, IOS_MULTI_TAP_DISTANCE);
    const tapCount: 1 | 2 | 3 = continuesTapSequence ? (previous.tapCount === 1 ? 2 : 3) : 1;
    this.previousIosOffTextTap =
      tapCount === 3 ? null : { document: this.view.state.doc, point, timeStamp, tapCount };
    return tapCount;
  }

  private resetTouchGesture(): void {
    this.touchStart = null;
    this.touchStartedLink = null;
    this.touchMoved = false;
  }
}

/** Installs the complete editor pointer policy for one host profile and owns its lifecycle. */
export function editorPointerInteractions(options: EditorPointerInteractionOptions): Extension {
  const pointerPlugin = ViewPlugin.define((view) => new EditorPointerController(view, options), {
    eventHandlers: {
      touchstart(event) {
        return this.handlesTouchAtScroller ? false : this.handleTouchStart(event);
      },
      touchmove(event) {
        return this.handlesTouchAtScroller ? false : this.handleTouchMove(event);
      },
      touchend(event) {
        return this.handlesTouchAtScroller ? false : this.handleTouchEnd(event);
      },
      touchcancel() {
        return this.handlesTouchAtScroller ? false : this.handleTouchCancel();
      },
      mousedown(event) {
        return this.handleMouseDown(event);
      },
      click(event) {
        return this.handleClick(event);
      },
      auxclick(event) {
        return this.handleAuxClick(event);
      },
    },
  });

  const extensions: Extension[] = [markdownSelectionRevealState, pointerPlugin];
  if (usesIosTouchPolicy(options.profile)) {
    extensions.push(EditorView.editorAttributes.of({ 'data-ios-off-text-surface': 'true' }));
  }
  if (usesDesktopPointerPolicy(options.profile)) extensions.push(desktopOffTextSelection());
  return extensions;
}

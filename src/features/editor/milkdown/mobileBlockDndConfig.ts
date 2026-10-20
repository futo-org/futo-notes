export type MobileDndHapticKind = 'lift' | 'move' | 'drop';

export interface MobileBlockDndOptions {
  /** Fired on lift, on every boundary the drop indicator moves to, and on a
   * committed (non-no-op) drop. See {@link MobileDndHapticKind}. */
  onHaptic: (kind: MobileDndHapticKind) => void;
  /**
   * True when a block goes airborne, false the moment the gesture resolves in
   * ANY way — commit, no-op drop, or cancel. The iOS shell suspends WKWebView's
   * text-interaction gestures for that window, which is the only thing that
   * stops the OS magnifier appearing over the block being dragged (see the
   * module doc's loupe note and bridge.ts BlockDragMessage). Optional: the
   * plugin is fully functional without a listener, just with the loupe.
   */
  onDragActive?: (active: boolean) => void;
  /**
   * True the instant a finger lands on a block, false the instant that press
   * resolves in ANY way — lift, plain tap, scroll, or cancel. Strictly wider
   * than {@link MobileBlockDndOptions.onDragActive}, and the whole point of it
   * is that it does NOT wait for the long-press timer: the iOS shell stands
   * WKWebView's delayed text-interaction gestures down here, so the OS
   * magnifier cannot appear even when no lift follows (see the module doc's
   * touch-down note and bridge.ts BlockPressMessage). Optional: the plugin is
   * fully functional without a listener, just back to racing the OS.
   */
  onPressActive?: (pressed: boolean) => void;
  /** Stationary hold (ms) before a touch lifts a block. Default 340, which is
   * a FEEL number, not a race number: iOS's own text interaction was measured at
   * 655ms focused / ~700ms unfocused, and `onPressActive` — not this timer — is
   * what keeps it out of the way (see the module doc's touch-down note). No
   * caller overrides either of these today; they exist because both numbers
   * were tuned by hand on a device and the next tuning pass wants a dial. */
  longPressMs?: number;
  /** Movement (px) before the timer fires that cancels the pending lift and
   * lets the gesture pass through as an ordinary scroll. */
  moveCancelPx?: number;
}

/** Exported so a test can hold for longer than the lift timer without
 * hardcoding a second copy of the number. */
export const DEFAULT_LONG_PRESS_MS = 340;

/** How long a released hold keeps absorbing the native click's deferred focus. */
export const FOCUS_GUARD_MS = 1000;

export const DEFAULT_MOVE_CANCEL_PX = 10;

/** Marks the ProseMirror root for the whole gesture (pointerdown -> release),
 * not just the drag: iOS's selection gesture starts long before our lift. */
export const ARMED_CLASS = 'futo-mobile-dnd-armed';

/** Paints any range WebKit establishes anyway as transparent. SEPARATE from
 * ARMED_CLASS because its descendant `::selection` rule restyles the WHOLE note
 * on every toggle — measured under Chromium (4x CPU throttle) at 21ms/65ms add
 * and the same again on remove for 1,000/3,000 blocks (~0.8s/2.3s on a real
 * Android phone), versus 0.5/1.4ms for the user-select declarations alone; no
 * selector shape (child/tag/:where/sheet or media toggle/custom property) was
 * cheaper there. Only added where the race it covers was actually measured
 * (iOS WebKit, see `needsSelectionNet`). */
export const HIDE_SELECTION_CLASS = 'futo-mobile-dnd-hide-selection';

/** iOS WKWebView is the only engine here that commits to a selection the page
 * cannot cancel (module doc); Chromium's long-press selection is stopped by the
 * synchronous `selectstart` cancel alone. So the net is skipped only for a
 * positively identified Chromium: `navigator.userAgentData` (Chromium-only, but
 * Android WebView has it only from v116, and the editor supports 80+) or a
 * `Chrome/` / `Chromium/` UA token (Android WebView carries it; iOS Chrome,
 * Edge and Firefox are WebKit and carry `CriOS/`, `EdgiOS/`, `FxiOS/` instead,
 * and any iPhone/iPad/iPod UA keeps the net regardless). An engine we cannot
 * identify keeps the net rather than silently losing it. Exported for the
 * test, which feeds it real UA strings. */
export function needsSelectionNet(
  nav: { userAgent?: string; userAgentData?: unknown } | undefined = typeof navigator ===
  'undefined'
    ? undefined
    : navigator,
): boolean {
  if (!nav) return true;
  const ua = nav.userAgent ?? '';
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return true;
  if ('userAgentData' in nav) return false;
  return !/\b(Chrome|Chromium)\//.test(ua);
}

/** Injected once per page (not per editor instance/mount). The ghost, indicator
 * and source-dim styles are the shared session's (blockDragSession.ts). */
let stylesInjected = false;
export function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-futo-mobile-block-dnd', '');
  style.textContent = `
    /* Selection suppression for the WHOLE gesture — see the module doc's
     * "selection suppression is a whole-gesture job". !important because
     * milkdownEditor.css's own '.futo-milkdown .ProseMirror ::selection'
     * rule is equally specific and would otherwise win on source order. */
    .${ARMED_CLASS} {
      -webkit-user-select: none !important;
      user-select: none !important;
      -webkit-touch-callout: none !important;
    }
    .${HIDE_SELECTION_CLASS} ::selection,
    .${HIDE_SELECTION_CLASS}::selection {
      background: transparent !important;
      color: inherit !important;
    }
  `;
  document.head.appendChild(style);
}

export type PressedBlock = {
  pos: number;
  size: number;
  dom: HTMLElement;
  clone: HTMLElement;
  /** False for an empty paragraph (module doc's "an empty paragraph cannot be
   * lifted") — the press still arms and runs the timer, `beginLift` just
   * refuses to actually lift it. */
  liftable: boolean;
};

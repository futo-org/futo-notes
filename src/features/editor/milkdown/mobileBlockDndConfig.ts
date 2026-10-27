export type MobileDndHapticKind = 'lift' | 'move' | 'drop';

export interface MobileBlockDndOptions {
  onHaptic: (kind: MobileDndHapticKind) => void;
  /** Suspends the native text-interaction stack for the lifted drag. */
  onDragActive?: (active: boolean) => void;
  /** Suspends delayed native long-press recognition from touch-down. */
  onPressActive?: (pressed: boolean) => void;
  longPressMs?: number;
  moveCancelPx?: number;
}

export const DEFAULT_LONG_PRESS_MS = 340;
export const DEFAULT_MOVE_CANCEL_PX = 10;
export const FOCUS_GUARD_MS = 1000;
export const ARMED_CLASS = 'futo-mobile-dnd-armed';
export const HIDE_SELECTION_CLASS = 'futo-mobile-dnd-hide-selection';

/** Chromium honors selectstart cancellation. WebKit needs the additional
 * transparent selection paint; unknown engines keep that protection. Skip it
 * only on positively identified Chromium: toggling ::selection over a large
 * note restyles every block (measured at 2.3s for 3,000 blocks on Android).
 * iOS browsers are WebKit even when their brand is Chrome, Edge or Firefox. */
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

let stylesInjected = false;

export function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-futo-mobile-block-dnd', '');
  // user-select alone does not stop selection inside WebKit contenteditables.
  // !important beats the editor's own equally specific selection-paint rule.
  style.textContent = `
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

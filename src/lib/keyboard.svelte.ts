let _height = $state(0);
let _visible = $state(false);
let _offsetTop = $state(0);

let initialized = false;
let refreshImpl: (() => void) | null = null;

function isIOSWebKit(): boolean {
  return /iP(hone|ad|od)/.test(navigator.platform) || /\biP(hone|ad|od)\b/.test(navigator.userAgent);
}

function resetLayoutViewportScroll(): void {
  if (!isIOSWebKit()) return;
  if (window.scrollY === 0 && document.documentElement.scrollTop === 0 && document.body.scrollTop === 0) return;
  try {
    window.scrollTo(0, 0);
  } catch {
    // jsdom and some embedded contexts may not implement scrollTo.
  }
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

function getLayoutViewportHeight(): number {
  return Math.max(
    document.documentElement.clientHeight,
    document.body.clientHeight,
    window.innerHeight
  );
}

function init(): void {
  if (initialized) return;
  initialized = true;

  const vv = window.visualViewport;
  if (!vv) return;

  const sync = () => {
    if (typeof document === 'undefined') return;
    const diff = getLayoutViewportHeight() - vv.height;
    const visible = diff > 100;
    if (visible) {
      resetLayoutViewportScroll();
      _height = diff;
      _visible = true;
    } else {
      _height = 0;
      _visible = false;
    }
    // iOS WKWebView shifts the visual viewport within the layout viewport
    // when the software keyboard opens to keep the focused input visible.
    // Absolutely-positioned chrome (menu buttons) then appears to drift off
    // the top of the visible area. Callers compensate with this offset.
    _offsetTop = visible && isIOSWebKit() ? 0 : vv.offsetTop;
  };

  const syncAfterViewportSettles = () => {
    sync();
    requestAnimationFrame(sync);
    for (const delay of [80, 240, 500, 900]) {
      setTimeout(sync, delay);
    }
  };

  refreshImpl = syncAfterViewportSettles;
  vv.addEventListener('resize', syncAfterViewportSettles);
  vv.addEventListener('scroll', syncAfterViewportSettles);
  document.addEventListener('focusin', syncAfterViewportSettles);
  document.addEventListener('focusout', syncAfterViewportSettles);
  window.addEventListener('scroll', syncAfterViewportSettles, { passive: true });
  sync();
}

function refresh(): void {
  refreshImpl?.();
}

function hide(): void {
  (document.activeElement as HTMLElement | null)?.blur();
}

export const keyboard = {
  get height() { return _height; },
  get visible() { return _visible; },
  get offsetTop() { return _offsetTop; },
  init,
  refresh,
  hide,
};

let _height = $state(0);
let _visible = $state(false);
let _offsetTop = $state(0);

let initialized = false;

function init(): void {
  if (initialized) return;
  initialized = true;

  const vv = window.visualViewport;
  if (!vv) return;

  const sync = () => {
    const diff = window.innerHeight - vv.height;
    if (diff > 100) {
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
    _offsetTop = vv.offsetTop;
  };

  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
}

function hide(): void {
  (document.activeElement as HTMLElement | null)?.blur();
}

export const keyboard = {
  get height() { return _height; },
  get visible() { return _visible; },
  get offsetTop() { return _offsetTop; },
  init,
  hide,
};

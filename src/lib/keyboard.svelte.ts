let _height = $state(0);
let _visible = $state(false);

let initialized = false;

function init(): void {
  if (initialized) return;
  initialized = true;

  const vv = window.visualViewport;
  if (!vv) return;

  const onResize = () => {
    const diff = window.innerHeight - vv.height;
    if (diff > 100) {
      _height = diff;
      _visible = true;
    } else {
      _height = 0;
      _visible = false;
    }
  };

  vv.addEventListener('resize', onResize);
}

function hide(): void {
  (document.activeElement as HTMLElement | null)?.blur();
}

export const keyboard = {
  get height() { return _height; },
  get visible() { return _visible; },
  init,
  hide,
};

import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';

const isNative = Capacitor.isNativePlatform();

let _height = $state(0);
let _visible = $state(false);

let initialized = false;

function init(): void {
  if (initialized) return;
  initialized = true;

  if (isNative) {
    Keyboard.addListener('keyboardWillShow', (info) => {
      _height = info.keyboardHeight;
      _visible = true;
    });
    Keyboard.addListener('keyboardWillHide', () => {
      _height = 0;
      _visible = false;
    });
  } else {
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
}

export const keyboard = {
  get height() { return _height; },
  get visible() { return _visible; },
  init,
};

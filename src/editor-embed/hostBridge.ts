import {
  hasNativeBridgeHost,
  type AndroidFutoBridgeHost,
  type IosFutoBridgeHost,
} from '@futo-notes/editor';

declare global {
  interface Window {
    webkit?: { messageHandlers?: { futoBridge?: IosFutoBridgeHost } };
    futoBridge?: AndroidFutoBridgeHost;
  }
}

/** Re-exported under the embed's own name; the detection itself belongs to the
 * bridge contract, so there is exactly one copy of the window sniff. */
export const hasNativeHost = hasNativeBridgeHost;

export function pickImageInBrowser(
  source: 'camera' | 'library',
  onselect: (dataUrl: string) => void,
): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  if (source === 'camera') input.setAttribute('capture', 'environment');
  input.hidden = true;
  input.onchange = () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') onselect(reader.result);
    };
    reader.readAsDataURL(file);
  };
  document.body.appendChild(input);
  input.click();
}

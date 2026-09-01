import { readLinuxDesktopSettings } from '$lib/platform';

export type LinuxInterfaceFont = 'systemUi' | 'sansSerif';
export type InterfaceFontPreference = 'system' | 'barlow';

let interfaceFontPreference: InterfaceFontPreference = 'barlow';

export function applyLinuxInterfaceFont(
  font: LinuxInterfaceFont,
  root: HTMLElement = document.documentElement,
): void {
  const family = font === 'sansSerif' ? 'sans-serif' : 'system-ui, sans-serif';
  root.style.setProperty('--font-sans', family);
  root.style.setProperty('--font-serif', family);
}

export function applyInterfaceFontPreference(
  preference: InterfaceFontPreference,
  root: HTMLElement = document.documentElement,
): void {
  interfaceFontPreference = preference;
  if (preference === 'barlow') {
    root.style.removeProperty('--font-sans');
    root.style.removeProperty('--font-serif');
    return;
  }

  void readLinuxDesktopSettings()
    .then((settings) => {
      if (settings && interfaceFontPreference === 'system') {
        applyLinuxInterfaceFont(settings.interfaceFont, root);
      }
    })
    .catch((error) => console.warn('Failed to read the Linux interface font:', error));
}

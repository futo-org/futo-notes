import { invoke } from '@tauri-apps/api/core';

export interface LinuxDesktopSettings {
  theme: 'dark' | 'light';
}

export function readLinuxDesktopSettings(): Promise<LinuxDesktopSettings> {
  return invoke<LinuxDesktopSettings>('linux_desktop_settings');
}

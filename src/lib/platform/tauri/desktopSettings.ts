import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface SystemAccent {
  r: number;
  g: number;
  b: number;
}

export interface LinuxDesktopSettings {
  theme: 'dark' | 'light';
  accent: SystemAccent | null;
}

export function readLinuxDesktopSettings(): Promise<LinuxDesktopSettings> {
  return invoke<LinuxDesktopSettings>('linux_desktop_settings');
}

/** Listen first and then read the current value, closing the startup race. */
export async function subscribeToLinuxAccent(
  handler: (accent: SystemAccent | null) => void,
): Promise<() => void> {
  const unlisten = await listen<SystemAccent | null>('linux-accent-changed', (event) =>
    handler(event.payload),
  );
  try {
    handler((await readLinuxDesktopSettings()).accent);
  } catch (error) {
    unlisten();
    throw error;
  }
  return unlisten;
}

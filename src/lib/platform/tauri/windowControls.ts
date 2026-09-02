import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export type WindowControl = 'minimize' | 'maximize' | 'close';

export interface WindowControlsLayout {
  left: WindowControl[];
  right: WindowControl[];
}

export async function readWindowControlsLayout(): Promise<WindowControlsLayout> {
  return invoke<WindowControlsLayout>('window_controls_layout');
}

export async function minimizeAppWindow(): Promise<void> {
  await getCurrentWindow().minimize();
}

export async function toggleMaximizeAppWindow(): Promise<void> {
  await getCurrentWindow().toggleMaximize();
}

export async function closeAppWindow(): Promise<void> {
  await getCurrentWindow().close();
}

export async function applyAppWindowTitle(noteTitle?: string): Promise<void> {
  const appName = import.meta.env.DEV ? 'FUTO Notes (Dev)' : 'FUTO Notes';
  const title = noteTitle ? `${noteTitle} — ${appName}` : appName;
  await getCurrentWindow().setTitle(title);
}

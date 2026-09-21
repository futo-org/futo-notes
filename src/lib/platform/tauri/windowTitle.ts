import { getCurrentWindow } from '@tauri-apps/api/window';

export async function applyApplicationWindowTitle(title: string): Promise<void> {
  await getCurrentWindow().setTitle(title);
}

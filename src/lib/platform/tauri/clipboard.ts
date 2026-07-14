import { writeText } from '@tauri-apps/plugin-clipboard-manager';

export async function writeClipboardText(text: string): Promise<void> {
  await writeText(text);
}

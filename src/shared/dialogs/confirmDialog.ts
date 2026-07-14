import { isTauri } from '$lib/platform';

export async function confirmDialog(
  message: string,
  options: { title: string; kind?: 'info' | 'warning' | 'error' },
): Promise<boolean> {
  if (isTauri) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return ask(message, options);
  }
  return window.confirm(message);
}

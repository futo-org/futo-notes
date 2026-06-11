import { isTauri } from '$lib/platform';

/**
 * Platform-aware confirmation dialog.
 *
 * In Tauri webviews `window.confirm()` doesn't block (see AGENTS.md), so we
 * must use `ask()` from @tauri-apps/plugin-dialog there. In the plain web
 * shell (dev server, Playwright) the plugin has no backend and `ask()`
 * throws — but `window.confirm()` blocks correctly, so it is the right
 * primitive.
 *
 * Like `ask()`, this can reject under Tauri (missing dialog capability,
 * etc.) — callers guarding destructive actions should treat a rejection as
 * "cancel".
 */
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

/**
 * Detect "not found" errors from @tauri-apps/plugin-fs.
 * Uses string matching as the plugin doesn't expose typed error codes.
 * This is a known fragility — if plugin-fs changes error message formats,
 * this function may need updating.
 */
export function isNotFound(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('not found') || msg.includes('no such file') || msg.includes('notfound');
  }
  // plugin-fs may throw string errors in some edge cases
  if (typeof err === 'string') {
    const msg = err.toLowerCase();
    return msg.includes('not found') || msg.includes('no such file');
  }
  return false;
}

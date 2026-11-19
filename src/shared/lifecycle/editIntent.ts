/**
 * "An edit is about to happen or just did" — raised before the work that can stall
 * the page, heard by the close-deadline reporter (src/app/closeDeadlineDirty.ts).
 *
 * The desktop editor does not raise it. On desktop only the notes-shell test hook
 * does (installNotesShellTestHook.ts, standing in for typing). The Milkdown editor
 * raises it from its transaction dispatch (documentChanges.ts), but only the native
 * iOS/Android bundles mount Milkdown, and nothing listens there: it is a no-op.
 */
let listener: (() => void) | null = null;

export function setEditIntentListener(next: (() => void) | null): void {
  listener = next;
}

export function noteEditIntent(): void {
  listener?.();
}

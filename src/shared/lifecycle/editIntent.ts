/**
 * "An edit is about to happen or just did" — raised before the work that can stall
 * the page, heard by the close-deadline reporter (src/app/closeDeadlineDirty.ts).
 *
 * The editor raises it from its own transaction dispatch (documentChanges.ts), so
 * every edit source is covered: typing, keymap commands, toolbar and checkbox
 * clicks, paste, drop, undo. Nothing listens in the native iOS/Android bundles,
 * where it is a no-op.
 */
let listener: (() => void) | null = null;

export function setEditIntentListener(next: (() => void) | null): void {
  listener = next;
}

export function noteEditIntent(): void {
  listener?.();
}

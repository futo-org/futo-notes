/**
 * "An edit is about to happen or just did" — raised before the work that can stall
 * the page, heard by the close-deadline reporter (src/app/closeDeadlineDirty.ts).
 *
 * The desktop editor does not raise it. Only the notes-shell test hook does
 * (installNotesShellTestHook.ts, standing in for typing).
 */
let listener: (() => void) | null = null;

export function setEditIntentListener(next: (() => void) | null): void {
  listener = next;
}

export function noteEditIntent(): void {
  listener?.();
}

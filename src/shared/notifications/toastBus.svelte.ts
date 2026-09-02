// The single app-wide toast: one message at a time, auto-dismiss (app.md).
// App.svelte renders it; every feature emits through here.
let message = $state('');
let timer: number | null = null;

// How long a toast stays up. Raised from 3s to 5s on 2026-09-02: a sync failure
// toast is the only warning a user gets that their notes folder has gone
// missing, and three seconds is not long enough to read a message that names a
// full path and then tells you where to fix it. Exported so the test pins it
// rather than restating the number.
export const TOAST_DURATION_MS = 5000;

export function showGlobalToast(nextMessage: string): void {
  if (timer !== null) clearTimeout(timer);
  message = nextMessage;
  timer = window.setTimeout(() => {
    message = '';
    timer = null;
  }, TOAST_DURATION_MS);
}

export function currentToastMessage(): string {
  return message;
}

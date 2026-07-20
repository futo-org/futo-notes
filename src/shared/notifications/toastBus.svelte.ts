// The single app-wide toast: one message at a time, ~3s, auto-dismiss
// (app.md). App.svelte renders it; every feature emits through here.
let message = $state('');
let timer: number | null = null;

export function showGlobalToast(nextMessage: string): void {
  if (timer !== null) clearTimeout(timer);
  message = nextMessage;
  timer = window.setTimeout(() => {
    message = '';
    timer = null;
  }, 3000);
}

export function currentToastMessage(): string {
  return message;
}

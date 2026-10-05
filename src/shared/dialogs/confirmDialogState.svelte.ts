export interface ConfirmDialogOptions {
  title: string;
  kind?: 'info' | 'warning' | 'error';
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ConfirmDialogRequest extends ConfirmDialogOptions {
  message: string;
}

interface PendingConfirmation extends ConfirmDialogRequest {
  resolve: (confirmed: boolean) => void;
}

let current = $state<PendingConfirmation | null>(null);
const queued: PendingConfirmation[] = [];

function showNext(): void {
  current = queued.shift() ?? null;
}

export function requestConfirmation(
  message: string,
  options: ConfirmDialogOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    const pending = { message, ...options, resolve };
    if (current) queued.push(pending);
    else current = pending;
  });
}

export function currentConfirmDialog(): ConfirmDialogRequest | null {
  if (!current) return null;
  return {
    message: current.message,
    title: current.title,
    ...(current.kind ? { kind: current.kind } : {}),
    ...(current.confirmLabel ? { confirmLabel: current.confirmLabel } : {}),
    ...(current.cancelLabel ? { cancelLabel: current.cancelLabel } : {}),
  };
}

export function resolveConfirmDialog(confirmed: boolean): void {
  const pending = current;
  if (!pending) return;
  current = null;
  pending.resolve(confirmed);
  showNext();
}

export function resetConfirmDialogsForTest(): void {
  if (current) current.resolve(false);
  for (const pending of queued) pending.resolve(false);
  current = null;
  queued.length = 0;
}

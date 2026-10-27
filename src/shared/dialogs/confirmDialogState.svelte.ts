export interface ConfirmDialogOptions {
  title: string;
  kind?: 'info' | 'warning' | 'error';
  /** The confirm button's catalog key, which its `ConfirmDialog` verb claims; Confirm when none. */
  confirmLabelKey?: string;
}

export interface ConfirmDialogRequest extends ConfirmDialogOptions {
  message: string;
}

interface PendingConfirmation extends ConfirmDialogRequest {
  resolve: (confirmed: boolean) => void;
}

let current = $state<PendingConfirmation | null>(null);
const queued: PendingConfirmation[] = [];
// The rest of the act that asked the one on screen, when a verb started it (`continuesWith`).
let after: Promise<unknown> | undefined;

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
    ...(current.confirmLabelKey ? { confirmLabelKey: current.confirmLabelKey } : {}),
  };
}

/** Answering the confirmation on screen continues `act`, the act that asked it. */
export function continuesWith(act: Promise<unknown>): void {
  after = act;
}

/**
 * Answers the confirmation on screen. Resolves once the act that asked it has finished what
 * the answer started, when a verb started that act, so a receipt shows what confirming did.
 * How that act ends (a failure toast) is its own to show.
 */
export function resolveConfirmDialog(confirmed: boolean): Promise<void> | undefined {
  const pending = current;
  if (!pending) return undefined;
  const rest = after;
  after = undefined;
  current = null;
  pending.resolve(confirmed);
  showNext();
  return rest?.then(
    () => undefined,
    () => undefined,
  );
}

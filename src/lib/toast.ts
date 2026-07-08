/** Global toast emitter — lets non-component code surface messages. */

type Listener = (message: string) => void;

let listener: Listener | null = null;

/** Register the single toast listener (called by NotesShell on mount). */
export function onToast(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

/** Show a toast from anywhere. No-op if no listener is registered. */
export function showGlobalToast(message: string): void {
  listener?.(message);
}

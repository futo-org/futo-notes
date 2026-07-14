type Listener = (message: string) => void;

let listener: Listener | null = null;

export function onToast(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

export function showGlobalToast(message: string): void {
  listener?.(message);
}

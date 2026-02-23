let worker: Worker | null = null;
let ready = false;
let initPromise: Promise<void> | null = null;
let pendingResolve: ((v: Float32Array) => void) | null = null;
let pendingReject: ((e: Error) => void) | null = null;

export function isReady(): boolean {
  return ready;
}

export function init(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = new Promise<void>((resolve, reject) => {
    worker = new Worker(new URL('./embeddingWorker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event: MessageEvent) => {
      const { type, data, error } = event.data;
      if (type === 'ready') {
        ready = true;
        resolve();
      } else if (type === 'embedding') {
        pendingResolve?.(new Float32Array(data));
        pendingResolve = null;
        pendingReject = null;
      } else if (type === 'error') {
        const err = new Error(error);
        if (!ready) {
          reject(err);
        }
        pendingReject?.(err);
        pendingReject = null;
        pendingResolve = null;
      }
    };

    worker.postMessage({ type: 'init' });
  });

  return initPromise;
}

export function embed(text: string): Promise<Float32Array> {
  if (!worker || !ready) {
    return Promise.reject(new Error('Embedding worker not ready'));
  }

  return new Promise<Float32Array>((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;
    worker!.postMessage({ type: 'embed', text });
  });
}

export function terminate(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  ready = false;
  initPromise = null;
  pendingResolve = null;
  pendingReject = null;
}

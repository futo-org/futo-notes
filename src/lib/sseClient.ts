const SSE_DEBUG = false;

let clientId: string | null = null;
let eventSource: EventSource | null = null;
let stopped = false;

export function getClientId(): string {
  if (!clientId) {
    clientId = crypto.randomUUID();
  }
  return clientId;
}

export function startSSE(
  serverUrl: string,
  token: string,
  onSyncAvailable: () => void,
): void {
  stopSSE();
  stopped = false;

  const url = `${serverUrl}/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(getClientId())}`;
  if (SSE_DEBUG) console.debug('[SSE] connecting to', url.replace(/token=[^&]+/, 'token=***'));

  const es = new EventSource(url);

  es.addEventListener('sync_available', () => {
    if (SSE_DEBUG) console.debug('[SSE] sync_available received');
    onSyncAvailable();
  });

  es.onerror = () => {
    // EventSource auto-reconnects on transient errors.
    // If readyState is CLOSED, the server killed it (e.g. token revoked) — stop retrying.
    if (es.readyState === EventSource.CLOSED) {
      if (SSE_DEBUG) console.warn('[SSE] connection permanently closed, stopping');
      stopSSE();
    }
  };

  eventSource = es;
}

export function stopSSE(): void {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  stopped = true;
}

export function isSSEConnected(): boolean {
  return eventSource !== null && !stopped;
}

import { authFetch, AuthFetchError, getSyncConfig } from './authFetch';

const SSE_DEBUG = false;
const SSE_RECONNECT_DELAY_MS = 2_000;

let clientId: string | null = null;
let eventSource: EventSource | null = null;
let stopped = false;
let reconnectTimer: number | null = null;
let connectGeneration = 0;

class SseAuthError extends Error {}

export function getClientId(): string {
  if (!clientId) {
    clientId = crypto.randomUUID();
  }
  return clientId;
}

export function startSSE(
  onSyncAvailable: () => void,
  onSupersearchReady?: () => void,
): void {
  stopSSE();
  stopped = false;
  const generation = ++connectGeneration;

  const scheduleReconnect = (): void => {
    if (stopped || generation !== connectGeneration || reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, SSE_RECONNECT_DELAY_MS);
  };

  const connect = async (): Promise<void> => {
    try {
      let data: { ticket?: string };
      try {
        data = await authFetch<{ ticket?: string }>('/events/session', { method: 'POST' });
      } catch (e) {
        if (e instanceof AuthFetchError && (e.status === 401 || e.status === 403)) {
          throw new SseAuthError('SSE auth rejected');
        }
        throw e;
      }
      if (!data.ticket) {
        throw new Error('SSE ticket response missing ticket');
      }
      if (stopped || generation !== connectGeneration) return;

      const { serverUrl } = getSyncConfig();
      const url = `${serverUrl}/events?ticket=${encodeURIComponent(data.ticket)}&clientId=${encodeURIComponent(getClientId())}`;
      if (SSE_DEBUG) console.debug('[SSE] connecting to', url.replace(/ticket=[^&]+/, 'ticket=***'));

      const es = new EventSource(url);
      eventSource = es;

      es.addEventListener('sync_available', () => {
        if (SSE_DEBUG) console.debug('[SSE] sync_available received');
        onSyncAvailable();
      });

      es.addEventListener('supersearch_ready', () => {
        if (SSE_DEBUG) console.debug('[SSE] supersearch_ready received');
        onSupersearchReady?.();
      });

      es.onerror = () => {
        if (stopped || generation !== connectGeneration) return;
        // EventSource auto-reconnects on transient errors.
        // If readyState is CLOSED, fetch a fresh ticket and reconnect manually.
        if (es.readyState === EventSource.CLOSED) {
          if (SSE_DEBUG) console.warn('[SSE] connection closed, reconnecting');
          if (eventSource === es) {
            eventSource = null;
          }
          scheduleReconnect();
        }
      };
    } catch (e) {
      if (e instanceof SseAuthError) {
        if (SSE_DEBUG) console.warn('[SSE] auth rejected, stopping');
        stopSSE();
        return;
      }
      if (SSE_DEBUG) console.warn('[SSE] connect failed, retrying', e);
      scheduleReconnect();
    }
  };

  void connect();
}

export function stopSSE(): void {
  connectGeneration++;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  stopped = true;
}

export function isSSEConnected(): boolean {
  return eventSource !== null && !stopped;
}

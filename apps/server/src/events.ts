import type { SSEStreamingApi } from 'hono/streaming';
import { log } from './logger.js';

interface SSEClient {
  id: string;
  tokenHash: string;
  stream: SSEStreamingApi;
}

const clients = new Map<string, SSEClient>();

export function addClient(id: string, tokenHash: string, stream: SSEStreamingApi): void {
  // Close existing connection for same client ID (reconnect)
  const existing = clients.get(id);
  if (existing) {
    try { existing.stream.close(); } catch { /* already closed */ }
  }
  clients.set(id, { id, tokenHash, stream });
  log.info(`sse: client connected id=${id} (total=${clients.size})`);
}

export function removeClient(id: string): void {
  if (clients.delete(id)) {
    log.info(`sse: client disconnected id=${id} (total=${clients.size})`);
  }
}

export function broadcastSyncAvailable(excludeClientId?: string): void {
  for (const [id, client] of clients) {
    if (id === excludeClientId) continue;
    client.stream.writeSSE({ event: 'sync_available', data: '' }).catch(() => {
      try { client.stream.close(); } catch { /* ignore */ }
      clients.delete(id);
      log.info(`sse: removed dead client id=${id}`);
    });
  }
}

export function removeClientsByTokenHash(tokenHash: string): void {
  for (const [id, client] of clients) {
    if (client.tokenHash === tokenHash) {
      try { client.stream.close(); } catch { /* ignore */ }
      clients.delete(id);
      log.info(`sse: closed revoked session id=${id}`);
    }
  }
}

export function removeAllClients(): void {
  for (const [, client] of clients) {
    try { client.stream.close(); } catch { /* ignore */ }
  }
  clients.clear();
}

export function broadcastSupersearchReady(): void {
  for (const [id, client] of clients) {
    client.stream.writeSSE({ event: 'supersearch_ready', data: '' }).catch(() => {
      try { client.stream.close(); } catch { /* ignore */ }
      clients.delete(id);
      log.info(`sse: removed dead client id=${id}`);
    });
  }
}

// 30s keepalive heartbeat
const heartbeat = setInterval(() => {
  for (const [id, client] of clients) {
    client.stream.writeSSE({ event: 'heartbeat', data: '' }).catch(() => {
      try { client.stream.close(); } catch { /* ignore */ }
      clients.delete(id);
      log.debug(`sse: heartbeat removed dead client id=${id}`);
    });
  }
}, 30_000);
heartbeat.unref();

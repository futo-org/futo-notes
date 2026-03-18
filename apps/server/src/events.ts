import { randomUUID } from 'node:crypto';
import type { SSEStreamingApi } from 'hono/streaming';
import { log } from './logger.js';

interface SSEClient {
  id: string;
  tokenHash: string;
  stream: SSEStreamingApi;
}

interface SSETicket {
  tokenHash: string;
  expiresAt: number;
}

const clients = new Map<string, SSEClient>();
const tickets = new Map<string, SSETicket>();
const SSE_TICKET_TTL_MS = 5 * 60 * 1000;

export function issueSseTicket(tokenHash: string): string {
  const ticket = randomUUID();
  tickets.set(ticket, { tokenHash, expiresAt: Date.now() + SSE_TICKET_TTL_MS });
  return ticket;
}

export function resolveSseTicket(ticket: string): string | null {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    tickets.delete(ticket);
    return null;
  }
  tickets.delete(ticket);
  return entry.tokenHash;
}

function clearTicketsForTokenHash(tokenHash: string): void {
  for (const [ticket, entry] of tickets) {
    if (entry.tokenHash === tokenHash) {
      tickets.delete(ticket);
    }
  }
}

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
  clearTicketsForTokenHash(tokenHash);
  for (const [id, client] of clients) {
    if (client.tokenHash === tokenHash) {
      try { client.stream.close(); } catch { /* ignore */ }
      clients.delete(id);
      log.info(`sse: closed revoked session id=${id}`);
    }
  }
}

export function removeAllClients(): void {
  tickets.clear();
  for (const [, client] of clients) {
    try { client.stream.close(); } catch { /* ignore */ }
  }
  clients.clear();
}

export function broadcastPluginStatus(): void {
  for (const [id, client] of clients) {
    client.stream.writeSSE({ event: 'plugin_status', data: '' }).catch(() => {
      try { client.stream.close(); } catch { /* ignore */ }
      clients.delete(id);
      log.info(`sse: removed dead client id=${id}`);
    });
  }
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

const ticketCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= now) {
      tickets.delete(ticket);
    }
  }
}, 60_000);
ticketCleanup.unref();

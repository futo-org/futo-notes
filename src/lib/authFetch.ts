import { getCachedPreferences } from './preferences';

const AUTH_FETCH_TIMEOUT_MS = 10_000;

export class AuthFetchError extends Error {
  status: number;
  serverMessage?: string;

  constructor(status: number, message: string, serverMessage?: string) {
    super(message);
    this.name = 'AuthFetchError';
    this.status = status;
    this.serverMessage = serverMessage;
  }
}

export interface AuthFetchOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Return raw Response instead of parsed JSON. */
  raw?: boolean;
}

export function getSyncConfig(): { serverUrl: string; token: string } {
  const prefs = getCachedPreferences();
  return { serverUrl: prefs.sync.serverUrl, token: prefs.sync.token };
}

/**
 * Authenticated fetch against the sync server.
 *
 * Reads serverUrl + token from cached preferences, attaches Bearer header,
 * applies a 10s timeout, and parses JSON by default.
 *
 * When `opts.raw` is true the raw Response is returned (caller must handle
 * status checks). Otherwise non-ok responses throw AuthFetchError with
 * `.status` and `.serverMessage`.
 */
export async function authFetch<T>(path: string, opts?: AuthFetchOptions & { raw?: false }): Promise<T>;
export async function authFetch(path: string, opts: AuthFetchOptions & { raw: true }): Promise<Response>;
export async function authFetch<T>(path: string, opts?: AuthFetchOptions): Promise<T | Response> {
  const { serverUrl, token } = getSyncConfig();
  const url = `${serverUrl}${path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...opts?.headers,
  };

  const init: RequestInit = {
    method: opts?.method,
    headers,
  };

  if (opts?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  // Build timeout signal, compose with caller signal if provided
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);

  if (opts?.signal) {
    init.signal = AbortSignal.any([opts.signal, controller.signal]);
  } else {
    init.signal = controller.signal;
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } finally {
    clearTimeout(timeoutId);
  }

  if (opts?.raw) {
    return res;
  }

  if (!res.ok) {
    let serverMessage: string | undefined;
    try {
      const data = await res.json();
      if (
        data &&
        typeof data === 'object' &&
        'error' in data &&
        typeof (data as Record<string, unknown>).error === 'string'
      ) {
        serverMessage = (data as Record<string, string>).error;
      }
    } catch {
      // No parseable error body
    }
    throw new AuthFetchError(
      res.status,
      serverMessage || `HTTP ${res.status}`,
      serverMessage,
    );
  }

  return (await res.json()) as T;
}

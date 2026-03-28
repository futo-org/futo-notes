import { getSyncConfig } from '../authFetch';
import { authFetch, AuthFetchError } from '../authFetch';
import { showGlobalToast } from '../toast';

export function isReady(): boolean {
  const { serverUrl, token } = getSyncConfig();
  return Boolean(serverUrl && token);
}

let lastAuthToast = 0;

export async function embed(query: string, signal?: AbortSignal): Promise<Float32Array> {
  const { serverUrl, token } = getSyncConfig();
  if (!serverUrl || !token) {
    throw new Error('Server not configured');
  }

  try {
    const { vector } = await authFetch<{ vector: number[] }>('/search/embed-query', {
      method: 'POST',
      body: { query },
      signal,
    });
    return new Float32Array(vector);
  } catch (e) {
    if (e instanceof AuthFetchError && e.status === 401) {
      const now = Date.now();
      if (now - lastAuthToast > 30_000) {
        lastAuthToast = now;
        showGlobalToast('Session expired — sign in again to use AI search');
      }
    }
    throw e;
  }
}

import { getCachedPreferences } from '../preferences';
import { showGlobalToast } from '../toast';

export function isReady(): boolean {
  const prefs = getCachedPreferences();
  return Boolean(prefs.sync.serverUrl && prefs.sync.token);
}

let lastAuthToast = 0;

export async function embed(query: string, signal?: AbortSignal): Promise<Float32Array> {
  const prefs = getCachedPreferences();
  if (!prefs.sync.serverUrl || !prefs.sync.token) {
    throw new Error('Server not configured');
  }

  const res = await fetch(`${prefs.sync.serverUrl}/search/embed-query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${prefs.sync.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
    signal,
  });

  if (!res.ok) {
    if (res.status === 401) {
      const now = Date.now();
      if (now - lastAuthToast > 30_000) {
        lastAuthToast = now;
        showGlobalToast('Session expired — sign in again to use AI search');
      }
    }
    throw new Error(`Embed query failed: ${res.status}`);
  }

  const { vector } = await res.json();
  return new Float32Array(vector);
}

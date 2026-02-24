import { getCachedPreferences } from '../preferences';

export function isReady(): boolean {
  const prefs = getCachedPreferences();
  return Boolean(prefs.sync.serverUrl && prefs.sync.token);
}

export async function embed(query: string): Promise<Float32Array> {
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
  });

  if (!res.ok) {
    throw new Error(`Embed query failed: ${res.status}`);
  }

  const { vector } = await res.json();
  return new Float32Array(vector);
}

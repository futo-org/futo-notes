import { getFS, platformName } from '../platform';
import { loadSupersearchState, saveSupersearchState } from './state';
import type { SupersearchState } from './state';

interface SearchCapabilities {
  levels: number[];
  model: string;
  dims: number;
  chunk_count: number;
  last_indexed_at: number | null;
  artifact_version: string;
  artifact_hash: string;
}

export async function checkForUpdate(
  serverUrl: string,
  token: string,
): Promise<{ hasUpdate: boolean; capabilities: SearchCapabilities | null }> {
  try {
    const res = await fetch(`${serverUrl}/search/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { hasUpdate: false, capabilities: null };

    const capabilities = (await res.json()) as SearchCapabilities;
    if (!capabilities.artifact_hash) return { hasUpdate: false, capabilities };

    const currentState = await loadSupersearchState();
    const hasUpdate = !currentState || currentState.artifactHash !== capabilities.artifact_hash;
    return { hasUpdate, capabilities };
  } catch {
    return { hasUpdate: false, capabilities: null };
  }
}

export async function downloadArtifact(
  serverUrl: string,
  token: string,
  capabilities: SearchCapabilities,
): Promise<boolean> {
  const fs = getFS();

  try {
    if (platformName === 'electron') {
      // Electron: delegate to IPC (downloads SQLite .db)
      await fs.supersearchDownload!(serverUrl, token);
    } else if (platformName === 'capacitor') {
      // Capacitor: fetch binary vectors + manifest
      const [manifestRes, binRes] = await Promise.all([
        fetch(`${serverUrl}/search/index?format=manifest`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${serverUrl}/search/index?format=bin`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      if (!manifestRes.ok || !binRes.ok) return false;

      const manifest = await manifestRes.text();
      const binData = await binRes.arrayBuffer();

      await fs.writeBinaryAppData!('.supersearch-vectors.bin', binData);
      await fs.writeAppData('.supersearch-manifest.json', manifest);
    } else {
      // Web: no-op
      return false;
    }

    const newState: SupersearchState = {
      artifactVersion: capabilities.artifact_version,
      artifactHash: capabilities.artifact_hash,
      downloadedAt: Date.now(),
      model: capabilities.model,
      dims: capabilities.dims,
      chunkCount: capabilities.chunk_count,
    };
    await saveSupersearchState(newState);
    return true;
  } catch (e) {
    console.warn('[supersearch] artifact download failed:', e);
    return false;
  }
}

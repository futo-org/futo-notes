import { hasLocalArtifacts, loadSupersearchState } from './state';
import type { SupersearchState } from './state';
import { hasRustCore, supersearchDownloadWithMetaRust } from '../rustCore';

interface SearchCapabilities {
  levels: number[];
  model: string;
  dims: number;
  chunk_count: number;
  last_indexed_at: number | null;
  artifact_version: string;
  artifact_hash: string;
  query_prefix: string | null;
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
    const hasArtifacts = await hasLocalArtifacts();

    const hasUpdate = !currentState
      || currentState.artifactHash !== capabilities.artifact_hash
      || !hasArtifacts;
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
  try {
    if (!hasRustCore()) return false;

    const meta: SupersearchState = {
      artifactVersion: capabilities.artifact_version,
      artifactHash: capabilities.artifact_hash,
      downloadedAt: Date.now(),
      model: capabilities.model,
      dims: capabilities.dims,
      chunkCount: capabilities.chunk_count,
    };
    await supersearchDownloadWithMetaRust(serverUrl, token, meta);
    return true;
  } catch (e) {
    console.warn('[supersearch] artifact download failed:', e);
    return false;
  }
}

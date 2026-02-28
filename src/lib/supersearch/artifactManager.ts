import { hasLocalArtifacts, loadSupersearchState } from './state';
import type { SupersearchState } from './state';
import { hasRustCore, supersearchDownloadWithMetaRust } from '../rustCore';
import { setServerSearchCapabilities } from './capabilities';
import type { SearchCapabilities } from './capabilitiesTypes';

export async function checkForUpdate(
  serverUrl: string,
  token: string,
): Promise<{ hasUpdate: boolean; capabilities: SearchCapabilities | null }> {
  try {
    const res = await fetch(`${serverUrl}/search/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      setServerSearchCapabilities(null);
      return { hasUpdate: false, capabilities: null };
    }

    const capabilities = (await res.json()) as SearchCapabilities;
    setServerSearchCapabilities(capabilities);
    if (!capabilities.artifact_hash) return { hasUpdate: false, capabilities };

    const currentState = await loadSupersearchState();
    const hasArtifacts = await hasLocalArtifacts();

    const hasUpdate = !currentState
      || currentState.artifactHash !== capabilities.artifact_hash
      || !hasArtifacts;
    return { hasUpdate, capabilities };
  } catch {
    setServerSearchCapabilities(null);
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
    if (!capabilities.model || !capabilities.dims || !capabilities.artifact_version || !capabilities.artifact_hash) {
      return false;
    }

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

import { hasLocalArtifacts, loadSupersearchState } from './state';
import type { SupersearchState } from './state';
import { hasRustCore, supersearchDownloadWithMetaRust } from '../rustCore';
import { setServerSearchCapabilities } from './capabilities';
import type { SearchCapabilities } from './capabilitiesTypes';
import { authFetch, getSyncConfig } from '../authFetch';

export async function checkForUpdate(): Promise<{ hasUpdate: boolean; capabilities: SearchCapabilities | null }> {
  try {
    const capabilities = await authFetch<SearchCapabilities>('/search/capabilities');
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
  capabilities: SearchCapabilities,
): Promise<boolean> {
  try {
    if (!hasRustCore()) return false;
    if (!capabilities.model || !capabilities.dims || !capabilities.artifact_version || !capabilities.artifact_hash) {
      return false;
    }

    const { serverUrl, token } = getSyncConfig();
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

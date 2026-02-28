import { isSupersearchReady } from './state';
import { isReady as isEmbedderReady } from './queryEmbedder';
import type { SearchCapabilities } from './capabilitiesTypes';

export interface EffectiveSearchCapabilities {
  keyword: boolean;
  vector: boolean;
  hybrid: boolean;
}

let cachedServerCapabilities: SearchCapabilities | null = null;

export function setServerSearchCapabilities(capabilities: SearchCapabilities | null): void {
  cachedServerCapabilities = capabilities;
}

export function getServerSearchCapabilities(): SearchCapabilities | null {
  return cachedServerCapabilities;
}

function serverVectorSupported(capabilities: SearchCapabilities | null): boolean {
  if (!capabilities) return false;
  if (capabilities.methods?.vector) return capabilities.methods.vector.supported;
  return Boolean(
    capabilities.model
      && capabilities.dims
      && capabilities.artifact_version
      && capabilities.artifact_hash
      && capabilities.chunk_count > 0,
  );
}

function serverHybridSupported(capabilities: SearchCapabilities | null): boolean {
  if (!capabilities) return false;
  if (capabilities.methods?.hybrid) return capabilities.methods.hybrid.supported;
  return serverVectorSupported(capabilities);
}

export async function getEffectiveSearchCapabilities(
  serverCaps: SearchCapabilities | null,
): Promise<EffectiveSearchCapabilities> {
  const keyword = true;
  const serverSupportsVector = serverVectorSupported(serverCaps);
  const localVectorReady = await isSupersearchReady();
  const vector = serverSupportsVector && localVectorReady && isEmbedderReady();
  const hybrid = serverHybridSupported(serverCaps) && vector;
  return { keyword, vector, hybrid };
}

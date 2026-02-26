import { getFS, platformName } from '../platform';

const STATE_PATH = '.supersearch-state.json';

export interface SupersearchState {
  artifactVersion: string;
  artifactHash: string;
  downloadedAt: number;
  model: string;
  dims: number;
  chunkCount: number;
}

export async function loadSupersearchState(): Promise<SupersearchState | null> {
  try {
    const raw = await getFS().readAppData(STATE_PATH);
    if (!raw) return null;
    return JSON.parse(raw) as SupersearchState;
  } catch {
    return null;
  }
}

export async function saveSupersearchState(state: SupersearchState): Promise<void> {
  await getFS().writeAppData(STATE_PATH, JSON.stringify(state, null, 2));
}

export async function hasLocalArtifacts(): Promise<boolean> {
  const fs = getFS();

  if (platformName === 'electron') {
    if (!fs.supersearchHasArtifacts) return false;
    return fs.supersearchHasArtifacts();
  }

  if (platformName === 'capacitor') {
    const [manifest, binData] = await Promise.all([
      fs.readAppData('.supersearch-manifest.json'),
      fs.readBinaryAppData?.('.supersearch-vectors.bin'),
    ]);
    return Boolean(manifest && binData);
  }

  return false;
}

export async function isSupersearchReady(): Promise<boolean> {
  const state = await loadSupersearchState();
  if (state === null || state.artifactHash === '') return false;
  return hasLocalArtifacts();
}

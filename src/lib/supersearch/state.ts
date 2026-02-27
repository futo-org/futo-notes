import { getFS, platformName } from '../platform';
import { hasRustCore, supersearchIsReadyRust, supersearchGetStateRust } from '../rustCore';

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
  if (hasRustCore()) {
    return supersearchGetStateRust();
  }
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
  if (platformName === 'tauri' && fs.supersearchHasArtifacts) {
    return fs.supersearchHasArtifacts();
  }
  return false;
}

export async function isSupersearchReady(): Promise<boolean> {
  if (hasRustCore()) {
    return supersearchIsReadyRust();
  }
  const state = await loadSupersearchState();
  if (state === null || state.artifactHash === '') return false;
  return hasLocalArtifacts();
}

import { platformName } from '../platform';
import { hasRustCore, supersearchIsReadyRust, supersearchGetStateRust } from '../rustCore';
import { persistedJson } from '../persistedJson';
import { getFS } from '../platform';

const store = persistedJson<SupersearchState | null>({
  path: '.supersearch-state.json',
  defaultValue: null,
});

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
  return store.load();
}

export async function saveSupersearchState(state: SupersearchState): Promise<void> {
  await store.save(state);
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

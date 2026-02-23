import { getFS } from '../platform';

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

export async function isSupersearchReady(): Promise<boolean> {
  const state = await loadSupersearchState();
  return state !== null && state.artifactHash !== '';
}

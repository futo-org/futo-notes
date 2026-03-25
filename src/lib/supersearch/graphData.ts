import { getFS, platformName } from '../platform';
import { loadSyncState } from '../syncState';
import type { NotePreview } from '../../types';
import {
  buildGraphDataFromEntries,
  type GraphData,
  type GraphNode,
  type GraphCluster,
} from './graphLayout';

export type { GraphCluster, GraphData, GraphNode, GraphClusterInput } from './graphLayout';

let cached: GraphData | null = null;
let computing = false;

export function getCachedGraphData(): GraphData | null {
  return cached;
}

export function clearGraphCache(): void {
  cached = null;
}

export async function computeGraphData(notes: NotePreview[]): Promise<GraphData> {
  if (cached) return cached;
  if (computing) {
    // Wait up to 10s for a concurrent computation to finish, checking cached each iteration
    for (let i = 0; i < 100 && computing; i++) {
      if (cached) return cached;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (cached) return cached;
    // Timed out — reset the flag and fall through to retry
    computing = false;
  }

  computing = true;
  try {
    const fs = getFS();
    if (platformName !== 'tauri' || !fs.supersearchAllNoteVectors) {
      throw new Error('Graph data requires Tauri platform with supersearch artifacts');
    }

    const vectorEntries = await fs.supersearchAllNoteVectors();

    if (vectorEntries.length === 0) {
      cached = { nodes: [], clusters: [], nodeIndex: new Map() };
      return cached;
    }

    const syncState = await loadSyncState();
    const noteMap = new Map<string, NotePreview>();
    for (const note of notes) {
      noteMap.set(note.id, note);
    }

    const idByUuid = new Map<string, string>();
    for (const [id, uuid] of Object.entries(syncState.uuidById)) {
      idByUuid.set(uuid, id);
    }

    const graphEntries = vectorEntries
      .map((entry) => {
        const noteId = idByUuid.get(entry.uuid) ?? entry.uuid;
        const note = noteMap.get(noteId);
        if (!note) return null;
        return {
          noteId,
          uuid: entry.uuid,
          title: note.title,
          preview: note.preview,
          tags: note.tags,
          vector: entry.vector,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (graphEntries.length === 0) {
      cached = { nodes: [], clusters: [], nodeIndex: new Map() };
      return cached;
    }

    if (graphEntries.length === 1) {
      const entry = graphEntries[0];
      const node: GraphNode = {
        noteId: entry.noteId,
        title: entry.title,
        x: 0,
        y: 0,
        clusterId: 'cluster-0',
        clusterIndex: 0,
      };
      const cluster: GraphCluster = {
        id: 'cluster-0',
        label: entry.title,
        x: 0,
        y: 0,
        radius: 48,
        color: '#d96f32',
        noteIds: [entry.noteId],
      };
      const nodeIndex = new Map<string, number>();
      nodeIndex.set(entry.noteId, 0);
      cached = { nodes: [node], clusters: [cluster], nodeIndex };
      return cached;
    }

    cached = await buildGraphDataFromEntries(
      graphEntries,
      platformName === 'tauri' ? getFS() : undefined,
    );
    return cached;
  } finally {
    computing = false;
  }
}

import { getFS, platformName } from '../platform';
import { loadSyncState } from '../syncState';
import type { NotePreview } from '../../types';
import {
  buildGraphDataFromEntries,
  type GraphData,
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
    while (computing) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (cached) return cached;
  }

  computing = true;
  try {
    const fs = getFS();
    if (platformName !== 'tauri' || !fs.supersearchAllNoteVectors) {
      throw new Error('Graph data requires Tauri platform with supersearch artifacts');
    }

    const vectorEntries = await fs.supersearchAllNoteVectors();
    if (vectorEntries.length < 2) {
      throw new Error('Need at least 2 notes with vectors for graph');
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
          title: note.title,
          preview: note.preview,
          tags: note.tags,
          vector: entry.vector,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    cached = buildGraphDataFromEntries(graphEntries);
    return cached;
  } finally {
    computing = false;
  }
}

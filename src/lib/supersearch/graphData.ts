import { UMAP } from 'umap-js';
import { getFS, platformName } from '../platform';
import { loadSyncState } from '../syncState';
import type { NotePreview } from '../../types';

export interface GraphNode {
  noteId: string;
  title: string;
  x: number;
  y: number;
}

export interface GraphData {
  nodes: GraphNode[];
  nodeIndex: Map<string, number>; // noteId → index into nodes[]
}

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
    // Wait for in-flight computation
    while (computing) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (cached) return cached;
  }

  computing = true;
  try {
    const fs = getFS();
    if (platformName !== 'tauri' || !fs.supersearchAllNoteVectors) {
      throw new Error('Graph data requires Tauri platform with supersearch artifacts');
    }

    // 1. Fetch all note vectors in one call
    const entries = await fs.supersearchAllNoteVectors();
    if (entries.length < 2) {
      throw new Error('Need at least 2 notes with vectors for graph');
    }

    // 2. Map UUIDs → noteIds
    const syncState = await loadSyncState();
    const noteMap = new Map<string, NotePreview>();
    for (const note of notes) {
      noteMap.set(note.id, note);
    }

    // Build parallel arrays: vectors matrix + metadata
    const vectors: number[][] = [];
    const meta: { noteId: string; title: string }[] = [];

    // Build reverse UUID map for O(1) lookups
    const idByUuid = new Map<string, string>();
    for (const [id, uuid] of Object.entries(syncState.uuidById)) {
      idByUuid.set(uuid, id);
    }

    for (const entry of entries) {
      const noteId = idByUuid.get(entry.uuid) ?? entry.uuid;
      const note = noteMap.get(noteId);
      if (!note) continue;

      vectors.push(entry.vector);
      meta.push({ noteId, title: note.title });
    }

    if (vectors.length < 2) {
      throw new Error('Need at least 2 matched notes for graph');
    }

    // 3. Run UMAP: high-dimensional → 2D
    const nNeighbors = Math.min(15, Math.max(2, vectors.length - 1));
    const umap = new UMAP({ nComponents: 2, nNeighbors, minDist: 0.1 });
    const coords = umap.fit(vectors);

    // 4. Normalize UMAP output and scale based on note count
    let xMin = Infinity, xMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;
    for (const c of coords) {
      if (c[0] < xMin) xMin = c[0];
      if (c[0] > xMax) xMax = c[0];
      if (c[1] < yMin) yMin = c[1];
      if (c[1] > yMax) yMax = c[1];
    }
    const xRange = xMax - xMin || 1;
    const yRange = yMax - yMin || 1;

    // Scale range grows with sqrt(n) so nodes get consistent spacing
    const halfRange = Math.max(150, Math.sqrt(meta.length) * 35);

    const graphNodes: GraphNode[] = [];
    const nodeIndex = new Map<string, number>();

    for (let i = 0; i < meta.length; i++) {
      const x = ((coords[i][0] - xMin) / xRange) * halfRange * 2 - halfRange;
      const y = ((coords[i][1] - yMin) / yRange) * halfRange * 2 - halfRange;
      nodeIndex.set(meta[i].noteId, graphNodes.length);
      graphNodes.push({
        noteId: meta[i].noteId,
        title: meta[i].title,
        x,
        y,
      });
    }

    // 5. Collision resolution — spatial grid for O(n) per iteration
    const minDist = 12;
    const cellSize = minDist;
    for (let iter = 0; iter < 50; iter++) {
      let moved = false;
      const grid = new Map<string, number[]>();

      for (let i = 0; i < graphNodes.length; i++) {
        const cx = Math.floor(graphNodes[i].x / cellSize);
        const cy = Math.floor(graphNodes[i].y / cellSize);
        const key = `${cx},${cy}`;
        let bucket = grid.get(key);
        if (!bucket) { bucket = []; grid.set(key, bucket); }
        bucket.push(i);
      }

      for (const [key, indices] of grid) {
        const [cx, cy] = key.split(',').map(Number);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const neighbor = grid.get(`${cx + dx},${cy + dy}`);
            if (!neighbor) continue;
            for (const i of indices) {
              for (const j of neighbor) {
                if (j <= i) continue;
                const ddx = graphNodes[j].x - graphNodes[i].x;
                const ddy = graphNodes[j].y - graphNodes[i].y;
                const dist = Math.sqrt(ddx * ddx + ddy * ddy);
                if (dist < minDist) {
                  if (dist > 0) {
                    const overlap = (minDist - dist) / 2;
                    const nx = ddx / dist;
                    const ny = ddy / dist;
                    graphNodes[i].x -= nx * overlap;
                    graphNodes[i].y -= ny * overlap;
                    graphNodes[j].x += nx * overlap;
                    graphNodes[j].y += ny * overlap;
                  } else {
                    graphNodes[j].x += (Math.random() - 0.5) * minDist;
                    graphNodes[j].y += (Math.random() - 0.5) * minDist;
                  }
                  moved = true;
                }
              }
            }
          }
        }
      }
      if (!moved) break;
    }

    cached = { nodes: graphNodes, nodeIndex };
    return cached;
  } finally {
    computing = false;
  }
}

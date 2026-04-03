import { sanitizeTitle } from '@futo-notes/shared';
import { getAppState, updateAppState, type ServerGraphLayout } from '../appState';
import { authFetch } from '../authFetch';
import {
  CLUSTER_COLORS,
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

// ── Server-based graph layout ─────────────────────────────────────────

/**
 * Convert a server graph layout response into the GraphData shape
 * that GraphCanvas.svelte expects.
 */
function serverLayoutToGraphData(layout: ServerGraphLayout): GraphData {
  // Build clusters first so nodes can reference them by index
  const clusters: GraphCluster[] = layout.clusters
    .slice()
    .sort((a, b) => b.filenames.length - a.filenames.length || a.index - b.index)
    .map((sc, sortedIndex) => ({
      id: `cluster-${sortedIndex}`,
      label: sc.label,
      x: sc.center_x,
      y: sc.center_y,
      radius: sc.radius,
      color: CLUSTER_COLORS[sc.color_index % CLUSTER_COLORS.length],
      noteIds: Array.from(new Set(sc.filenames.map(filenameToNoteId))),
    }));

  // Map from original server cluster index to sorted index
  const clusterIndexMap = new Map<number, number>();
  layout.clusters
    .slice()
    .sort((a, b) => b.filenames.length - a.filenames.length || a.index - b.index)
    .forEach((sc, sortedIndex) => {
      clusterIndexMap.set(sc.index, sortedIndex);
    });

  const nodes: GraphNode[] = [];
  const nodeIndex = new Map<string, number>();
  const clusterIndexByNoteId = new Map<string, number>();

  for (const sc of layout.clusters) {
    const sortedClusterIdx = clusterIndexMap.get(sc.index) ?? -1;
    for (const filename of sc.filenames) {
      const noteId = filenameToNoteId(filename);
      if (!clusterIndexByNoteId.has(noteId)) {
        clusterIndexByNoteId.set(noteId, sortedClusterIdx);
      }
    }
  }

  for (const sn of layout.nodes) {
    const noteId = filenameToNoteId(sn.filename);
    if (nodeIndex.has(noteId)) continue;
    const sortedClusterIdx = clusterIndexByNoteId.get(noteId) ?? -1;
    nodeIndex.set(noteId, nodes.length);
    nodes.push({
      noteId,
      title: filenameToNoteId(sn.filename),
      x: sn.x,
      y: sn.y,
      clusterId: sortedClusterIdx >= 0 ? `cluster-${sortedClusterIdx}` : null,
      clusterIndex: sortedClusterIdx,
    });
  }

  return { nodes, clusters, nodeIndex };
}

/**
 * Derive the note ID from a sync-protocol filename (`{title}.md`).
 * The server always returns filenames with exactly one `.md` suffix.
 */
function filenameToNoteId(filename: string): string {
  return sanitizeTitle(filename.replace(/\.md$/i, ''));
}

async function fetchServerGraphLayout(): Promise<ServerGraphLayout | null> {
  try {
    return await authFetch<ServerGraphLayout>('/graph/layout');
  } catch {
    return null;
  }
}

/**
 * Try to load a graph via the V2 server layout endpoint.
 *
 * 1. If a cached layout exists in app state and is fresh, use it.
 * 2. Otherwise fetch from server.
 * 3. If server unreachable, fall back to stale cache.
 * 4. Returns null if no layout is available at all.
 */
async function loadServerGraphLayout(): Promise<{ data: GraphData; fromCache: boolean } | null> {
  const appState = getAppState();
  const cachedLayout = appState.graphLayout;
  const isFresh = cachedLayout && cachedLayout.serverVersion >= appState.lastServerVersion;

  if (isFresh) {
    return { data: serverLayoutToGraphData(cachedLayout.data), fromCache: false };
  }

  const serverLayout = await fetchServerGraphLayout();
  if (serverLayout) {
    // Cache the fresh layout
    await updateAppState({
      graphLayout: {
        serverVersion: appState.lastServerVersion,
        data: serverLayout,
      },
    });
    return { data: serverLayoutToGraphData(serverLayout), fromCache: false };
  }

  // Server unreachable — use stale cache if available
  if (cachedLayout) {
    return { data: serverLayoutToGraphData(cachedLayout.data), fromCache: true };
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────

export async function computeGraphData(): Promise<GraphData> {
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
    const appState = getAppState();
    if (!appState.serverUrl || !appState.authToken) {
      throw new Error('Connect to a server to view the graph');
    }

    const serverResult = await loadServerGraphLayout();
    if (serverResult) {
      cached = serverResult.data;
      return cached;
    }

    throw new Error('Graph layout is not available yet');
  } finally {
    computing = false;
  }
}

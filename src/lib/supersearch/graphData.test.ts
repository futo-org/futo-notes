import { beforeEach, describe, expect, it, vi } from 'vitest';
const mockAuthFetch = vi.fn();
const mockUpdateAppState = vi.fn();

let mockAppState = {
  serverUrl: 'https://sync.example.com',
  authToken: 'token',
  lastServerVersion: 7,
  graphLayout: undefined as
    | {
        serverVersion: number;
        data: {
          nodes: Array<{ filename: string; x: number; y: number; cluster_index: number }>;
          clusters: Array<{
            index: number;
            label: string;
            center_x: number;
            center_y: number;
            radius: number;
            color_index: number;
            filenames: string[];
          }>;
          note_count: number;
          indexed_count: number;
        };
      }
    | undefined,
};

vi.mock('../authFetch', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

vi.mock('../appState', () => ({
  getAppState: () => mockAppState,
  updateAppState: (...args: unknown[]) => mockUpdateAppState(...args),
}));

const { computeGraphData, clearGraphCache } = await import('./graphData');

describe('computeGraphData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGraphCache();
    mockAppState = {
      serverUrl: 'https://sync.example.com',
      authToken: 'token',
      lastServerVersion: 7,
      graphLayout: undefined,
    };
  });

  it('maps a server layout into GraphData and caches it', async () => {
    mockAuthFetch.mockResolvedValue({
      nodes: [{ filename: 'my-note.md.md', x: 120, y: -80, cluster_index: 0 }],
      clusters: [
        {
          index: 0,
          label: 'My Note',
          center_x: 120,
          center_y: -80,
          radius: 48,
          color_index: 0,
          filenames: ['my-note.md.md'],
        },
      ],
      note_count: 1,
      indexed_count: 1,
    });

    const result = await computeGraphData();

    expect(result.nodes).toEqual([
      {
        noteId: 'my-note',
        title: 'my-note',
        x: 120,
        y: -80,
        clusterId: 'cluster-0',
        clusterIndex: 0,
      },
    ]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]).toMatchObject({ x: 120, y: -80, radius: 48 });
    expect(result.nodeIndex.get('my-note')).toBe(0);
    expect(mockUpdateAppState).toHaveBeenCalledWith({
      graphLayout: {
        serverVersion: 7,
        data: expect.objectContaining({
          note_count: 1,
          indexed_count: 1,
        }),
      },
    });
  });

  it('uses stale cached server layout when fetch fails', async () => {
    mockAppState.graphLayout = {
      serverVersion: 6,
      data: {
        nodes: [{ filename: 'cached.md', x: 90, y: 30, cluster_index: 0 }],
        clusters: [
          {
            index: 0,
            label: 'Cached',
            center_x: 90,
            center_y: 30,
            radius: 48,
            color_index: 1,
            filenames: ['cached.md'],
          },
        ],
        note_count: 1,
        indexed_count: 1,
      },
    };
    mockAuthFetch.mockRejectedValue(new Error('offline'));

    const result = await computeGraphData();

    expect(result.nodes[0]?.noteId).toBe('cached');
    expect(mockUpdateAppState).not.toHaveBeenCalled();
  });

  it('throws when no sync server is configured', async () => {
    mockAppState.serverUrl = '';
    mockAppState.authToken = '';

    await expect(computeGraphData()).rejects.toThrow('Connect to a server to view the graph');
  });

  it('deduplicates repeated markdown-suffix variants into one node', async () => {
    mockAuthFetch.mockResolvedValue({
      nodes: [
        { filename: 'dupe.md', x: 10, y: 20, cluster_index: 0 },
        { filename: 'dupe.md.md', x: 10, y: 20, cluster_index: 0 },
      ],
      clusters: [
        {
          index: 0,
          label: 'Dupe',
          center_x: 10,
          center_y: 20,
          radius: 48,
          color_index: 0,
          filenames: ['dupe.md', 'dupe.md.md'],
        },
      ],
      note_count: 2,
      indexed_count: 2,
    });

    const result = await computeGraphData();

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.noteId).toBe('dupe');
    expect(result.clusters[0]?.noteIds).toEqual(['dupe']);
  });
});


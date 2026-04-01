/**
 * Graph visualization types and constants.
 *
 * Layout computation is handled server-side via /graph/layout.
 * This module only exports the shared types consumed by graphData.ts
 * and GraphCanvas.svelte.
 */

export interface GraphNode {
  noteId: string;
  title: string;
  x: number;
  y: number;
  clusterId: string | null;
  clusterIndex: number;
}

export interface GraphCluster {
  id: string;
  label: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  noteIds: string[];
}

export interface GraphData {
  nodes: GraphNode[];
  clusters: GraphCluster[];
  nodeIndex: Map<string, number>;
}

export interface GraphClusterInput {
  noteId: string;
  uuid?: string;
  title: string;
  preview: string;
  tags: string[];
  vector: number[];
  x: number;
  y: number;
}

export interface GraphVectorEntry {
  noteId: string;
  uuid?: string;
  title: string;
  preview: string;
  tags: string[];
  vector: number[];
}

export const CLUSTER_COLORS = [
  '#d96f32',
  '#4f8f87',
  '#b0533e',
  '#6a8a3a',
  '#4f73b8',
  '#b47b1f',
  '#8f5cb3',
  '#2c8f68',
  '#b84f7d',
  '#6e6ccf',
  '#9a6e43',
  '#477f9a',
];

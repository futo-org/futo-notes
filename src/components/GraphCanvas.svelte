<script lang="ts">
  import type { GraphData, GraphNode } from '$lib/supersearch/graphData';
  import { untrack } from 'svelte';
  import ForceGraph from 'force-graph';
  import type { NodeObject } from 'force-graph';

  interface Props {
    data: GraphData;
    currentNoteId: string | null;
    onNavigate: (noteId: string) => void;
  }

  let { data, currentNoteId, onNavigate }: Props = $props();

  let container: HTMLDivElement | undefined = $state(undefined);

  type GraphNodeObj = NodeObject & GraphNode;

  let graph: InstanceType<typeof ForceGraph<GraphNodeObj>> | null = null;
  let prevNoteId: string | null = null;

  function hexToRgba(hex: string, alpha: number): string {
    const normalized = hex.replace('#', '');
    const full = normalized.length === 3
      ? normalized.split('').map((part) => `${part}${part}`).join('')
      : normalized;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function getColors() {
    if (!container) return { primary: '#6366f1', muted: '#9ca3af', bg: '#ffffff' };
    const s = getComputedStyle(container);
    return {
      primary: s.getPropertyValue('--color-primary').trim() || '#6366f1',
      muted: s.getPropertyValue('--color-muted').trim() || '#9ca3af',
      bg: s.getPropertyValue('--color-bg').trim() || '#ffffff',
    };
  }

  function buildGraphData() {
    const nodes: GraphNodeObj[] = data.nodes.map((n) => ({
      ...n,
      id: n.noteId,
      fx: n.x,
      fy: n.y,
    }));
    return { nodes, links: [] as Array<{ source: string; target: string }> };
  }

  function centerOnNode(noteId: string) {
    if (!graph) return;
    const idx = data.nodeIndex.get(noteId);
    if (idx === undefined) return;
    const n = data.nodes[idx];
    graph.centerAt(n.x, n.y, 600);
  }

  function clusterColor(node: GraphNodeObj, currentId: string | null): string {
    const colors = getColors();
    if (node.noteId === currentId) return colors.primary;
    const cluster = node.clusterIndex >= 0 ? data.clusters[node.clusterIndex] : null;
    return cluster ? cluster.color : colors.muted;
  }

  function drawClusterHalos(ctx: CanvasRenderingContext2D, globalScale: number): void {
    for (const cluster of data.clusters) {
      const gradient = ctx.createRadialGradient(
        cluster.x,
        cluster.y,
        Math.max(8, cluster.radius * 0.1),
        cluster.x,
        cluster.y,
        cluster.radius,
      );
      gradient.addColorStop(0, hexToRgba(cluster.color, globalScale > 2 ? 0.08 : 0.12));
      gradient.addColorStop(1, hexToRgba(cluster.color, 0));
      ctx.beginPath();
      ctx.arc(cluster.x, cluster.y, cluster.radius, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
    }
  }

  // Create ForceGraph instance — depends only on container
  $effect(() => {
    if (!container) return;

    const colors = getColors();
    const initialData = untrack(() => buildGraphData());

    const g = new ForceGraph<GraphNodeObj>(container)
      .backgroundColor(colors.bg)
      .nodeId('noteId')
      .nodeLabel('title')
      .nodeVal((n) => (n.noteId === currentNoteId ? 4.8 : 2.2))
      .nodeColor((n) => clusterColor(n, currentNoteId))
      .nodeCanvasObject((node, ctx) => {
        const isCurrent = node.noteId === currentNoteId;
        const x = node.x!;
        const y = node.y!;
        const r = isCurrent ? 5.5 : 2.8;
        const fill = clusterColor(node, currentNoteId);

        if (isCurrent) {
          ctx.beginPath();
          ctx.arc(x, y, 10, 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(fill, 0.18);
          ctx.globalAlpha = 0.15;
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.globalAlpha = isCurrent ? 1 : 0.82;
        ctx.fill();
        if (!isCurrent) {
          ctx.strokeStyle = hexToRgba(fill, 0.4);
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      })
      .nodeCanvasObjectMode(() => 'after')
      .nodePointerAreaPaint((node, color, ctx) => {
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, 8, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      })
      .onNodeClick((node) => {
        onNavigate(node.noteId);
      })
      .onRenderFramePre((ctx, globalScale) => {
        drawClusterHalos(ctx, globalScale);
      })
      .enableNodeDrag(false)
      .cooldownTicks(0)
      .minZoom(0.22)
      .maxZoom(12)
      .graphData(initialData);

    graph = g;

    // Initial view: fit all nodes, then center on current note
    requestAnimationFrame(() => {
      g.zoomToFit(0, 40);
      const cid = untrack(() => currentNoteId);
      if (cid && untrack(() => data.nodeIndex.has(cid))) {
        untrack(() => centerOnNode(cid));
      }
    });

    const ro = new ResizeObserver(() => {
      const rect = container!.getBoundingClientRect();
      g.width(rect.width);
      g.height(rect.height);
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      g._destructor();
      graph = null;
    };
  });

  // Push data changes to the existing ForceGraph (e.g. after rename)
  $effect(() => {
    // Read data.nodes via buildGraphData — Svelte 5 deep reactivity tracks mutations
    const gd = buildGraphData();
    if (!graph) return;
    graph.graphData(gd);
  });

  // Re-center when current note changes
  $effect(() => {
    if (currentNoteId && currentNoteId !== prevNoteId && graph) {
      // Refresh node colors/sizes to reflect new current
      graph.nodeVal((n: GraphNodeObj) => (n.noteId === currentNoteId ? 4.8 : 2.2));
      graph.nodeColor((n: GraphNodeObj) => clusterColor(n, currentNoteId));
      centerOnNode(currentNoteId);
    }
    prevNoteId = currentNoteId;
  });

  // Update graph colors when theme changes
  $effect(() => {
    if (!container) return;
    const observer = new MutationObserver(() => {
      if (!graph) return;
      const c = getColors();
      graph.backgroundColor(c.bg);
      graph.nodeColor((n: GraphNodeObj) => clusterColor(n, currentNoteId));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  });
</script>

<div
  bind:this={container}
  class="graph-canvas-container"
  style="width: 100%; height: 100%; overflow: hidden;"
></div>

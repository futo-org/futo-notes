<script lang="ts">
  import { isMobile, isDesktop } from '$lib/platform';
  import type { NotePreview } from '../types';

  interface Props {
    open: boolean;
    currentNoteId: string | null;
    graphSidebarWidth: number;
    notes: NotePreview[];
    onclose: () => void;
    onnavigate: (noteId: string) => void;
    onopen: () => void;
    ontoast: (message: string) => void;
    graphSidebarEl?: HTMLElement | undefined;
    graphOverlayEl?: HTMLElement | undefined;
    resizing?: boolean;
    loading?: boolean;
  }

  let {
    open,
    currentNoteId,
    graphSidebarWidth = $bindable(320),
    notes,
    onclose,
    onnavigate,
    onopen,
    ontoast,
    graphSidebarEl = $bindable(undefined),
    graphOverlayEl = $bindable(undefined),
    resizing = $bindable(false),
    loading = $bindable(false),
  }: Props = $props();

  let resizeStartX = 0;
  let resizeStartWidth = 0;

  export function patchGraphNode(_fromId: string, _toId: string, _newTitle: string): void {}
  export function clearGraphData(): void {}
  export function hasGraphData(): boolean { return false; }

  export async function openGraph(): Promise<void> {
    ontoast('Graph visualization coming soon');
    onclose();
  }

  function closeGraph(): void {
    onclose();
  }

  function handleDismissWindowKeydown(event: KeyboardEvent, dismiss: () => void): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
    }
  }

  $effect(() => {
    if (!(isMobile && (open || loading))) return;

    const handleWindowKeydown = (event: KeyboardEvent) => {
      handleDismissWindowKeydown(event, closeGraph);
    };

    window.addEventListener('keydown', handleWindowKeydown);
    return () => window.removeEventListener('keydown', handleWindowKeydown);
  });

  // Resize handlers
  function handleGraphResizeStart(e: PointerEvent): void {
    e.preventDefault();
    resizing = true;
    resizeStartX = e.clientX;
    resizeStartWidth = graphSidebarWidth;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handleGraphResizeMove(e: PointerEvent): void {
    if (!resizing) return;
    graphSidebarWidth = Math.max(200, Math.min(600, resizeStartWidth - (e.clientX - resizeStartX)));
  }

  function handleGraphResizeEnd(): void {
    if (!resizing) return;
    resizing = false;
    persistGraphSidebarWidth(graphSidebarWidth);
  }

  function persistGraphSidebarWidth(width: number): void {
    if (isDesktop) {
      import('$lib/platform/tauri').then(({ saveConfig }) => {
        saveConfig({ graphSidebarWidth: width });
      });
    } else {
      localStorage.setItem('futo-notes:graphSidebarWidth', String(width));
    }
  }
</script>

{#if open || loading}
  {#if isMobile}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={graphOverlayEl}
      class="graph-overlay"
      class:active={open}
      onclick={closeGraph}
      onkeydown={(event) => handleDismissWindowKeydown(event, closeGraph)}
    ></div>
  {/if}
  <aside bind:this={graphSidebarEl} class="graph-sidebar" class:open={open}>
    {#if !isMobile}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="graph-resize-handle"
        onpointerdown={handleGraphResizeStart}
        onpointermove={handleGraphResizeMove}
        onpointerup={handleGraphResizeEnd}
        onpointercancel={handleGraphResizeEnd}
      ></div>
    {/if}
    <div class="graph-sidebar-header">
      <span class="graph-sidebar-title">Graph</span>
      <div class="graph-sidebar-actions">
        <button class="graph-sidebar-close" aria-label="Close graph" onclick={closeGraph}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="graph-sidebar-body">
      {#if loading}
        <div class="graph-loading">Loading graph...</div>
      {/if}
    </div>
  </aside>
{/if}

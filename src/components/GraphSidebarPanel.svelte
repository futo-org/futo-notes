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

  let graphFullscreenOpen = $state(false);
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
    graphFullscreenOpen = false;
    onclose();
  }

  function openFullscreen(): void {
    if (!graphData) return;
    graphFullscreenOpen = true;
  }

  function closeFullscreen(): void {
    graphFullscreenOpen = false;
  }

  function handleDismissWindowKeydown(event: KeyboardEvent, dismiss: () => void): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
    }
  }

  $effect(() => {
    if (!(graphFullscreenOpen || (isMobile && (open || loading)))) return;

    const handleWindowKeydown = (event: KeyboardEvent) => {
      if (graphFullscreenOpen) {
        handleDismissWindowKeydown(event, closeFullscreen);
        return;
      }
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
        {#if graphData}
          <button class="graph-sidebar-expand" aria-label="Expand graph" onclick={openFullscreen}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 3 21 3 21 9"/>
              <polyline points="9 21 3 21 3 15"/>
              <line x1="21" y1="3" x2="14" y2="10"/>
              <line x1="3" y1="21" x2="10" y2="14"/>
            </svg>
          </button>
        {/if}
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
      {:else if graphData}
        <GraphCanvas data={graphData} currentNoteId={currentNoteId} onNavigate={onnavigate} />
      {/if}
    </div>
  </aside>
{/if}

{#if graphFullscreenOpen && graphData}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="graph-fullscreen-backdrop"
    onclick={closeFullscreen}
    onkeydown={(event) => handleDismissWindowKeydown(event, closeFullscreen)}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <section class="graph-fullscreen" onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.stopPropagation()}>
      <div class="graph-fullscreen-header">
        <div>
          <div class="graph-fullscreen-eyebrow">Semantic Map</div>
          <h2 class="graph-fullscreen-title">All Notes</h2>
        </div>
        <button class="graph-fullscreen-close" aria-label="Collapse graph" onclick={closeFullscreen}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 3 3 3 3 9"/>
            <polyline points="15 21 21 21 21 15"/>
            <line x1="3" y1="3" x2="10" y2="10"/>
            <line x1="21" y1="21" x2="14" y2="14"/>
          </svg>
        </button>
      </div>
      <div class="graph-fullscreen-body">
        <GraphCanvas data={graphData} currentNoteId={currentNoteId} onNavigate={onnavigate} />
      </div>
    </section>
  </div>
{/if}

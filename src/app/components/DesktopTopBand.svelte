<script lang="ts">
  import TabsStrip from '$features/tabs/TabsStrip.svelte';
  import type { NotePreview } from '$shared/types/note';

  interface Props {
    sidebarCollapsed: boolean;
    ontoggle: () => void;
    notes?: NotePreview[];
  }

  let { sidebarCollapsed, ontoggle, notes = [] }: Props = $props();
</script>

<!-- The full-width top band spans the whole window above the sidebar/editor
     row. Its leading `.topband-chrome` region mirrors the sidebar column and
     owns the macOS traffic-light gutter (`--macos-traffic-lights-width`), so
     the native buttons are cleared in exactly one place regardless of whether
     the sidebar is expanded or collapsed. The band is a `data-tauri-drag-region`
     so its empty areas drag the window; child buttons still receive clicks. -->
<div class="desktop-topband" data-tauri-drag-region>
  <div class="topband-chrome">
    <button
      type="button"
      class="sidebar-toggle-btn"
      aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-expanded={!sidebarCollapsed}
      title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      onclick={ontoggle}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="9" y1="3" x2="9" y2="21" />
        {#if sidebarCollapsed}
          <polyline points="14 8 17 12 14 16" />
        {:else}
          <polyline points="15 8 12 12 15 16" />
        {/if}
      </svg>
    </button>
  </div>
  <TabsStrip {notes} />
</div>

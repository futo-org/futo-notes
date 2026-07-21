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

<!-- Full-width desktop top band: chrome column (mirrors the sidebar, holds the
     sole sidebar toggle + the macOS traffic-light gutter) then the tab strip.
     The band is a drag region so the window moves from its empty areas. -->
<div class="desktop-topband" data-tauri-drag-region>
  <div class="topband-chrome">
    <button
      class="sidebar-toggle-btn"
      aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-expanded={!sidebarCollapsed}
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
      </svg>
    </button>
  </div>
  <TabsStrip {notes} />
</div>

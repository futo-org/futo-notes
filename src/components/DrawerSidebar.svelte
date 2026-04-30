<script lang="ts">
  import { getContext } from 'svelte';
  import { APP_CONTEXT_KEY, type AppContext } from '$lib/appContext.svelte';
  import { isMobile, isDesktop } from '$lib/platform';
  import VirtualList from './VirtualList.svelte';
  import SidebarTagView from './SidebarTagView.svelte';
  import SidebarImageView from './SidebarImageView.svelte';

  const appCtx = getContext<AppContext>(APP_CONTEXT_KEY);

  interface Props {
    drawerOpen: boolean;
    sidebarCollapsed: boolean;
    sidebarWidth: number;
    isDragging: boolean;
    onselect: (id: string) => void;
    onsearch: () => void;
    onsettings: () => void;
    onnewnote: () => void;
    oncreatetestnote: () => void;
    ontogglecollapse: (collapsed?: boolean) => void;
    drawerEl?: HTMLElement | undefined;
    sidebarResizing?: boolean;
  }

  let {
    drawerOpen,
    sidebarCollapsed,
    sidebarWidth = $bindable(280),
    isDragging,
    onselect,
    onsearch,
    onsettings,
    onnewnote,
    oncreatetestnote,
    ontogglecollapse,
    drawerEl = $bindable(undefined),
    sidebarResizing = $bindable(false),
  }: Props = $props();

  let sidebarView: 'notes' | 'tags' | 'images' = $state(
    (typeof localStorage !== 'undefined' && localStorage.getItem('futo-notes:sidebarView') as 'notes' | 'tags' | 'images') || 'notes'
  );

  function handleBrandClick(): void {
    onselect('__home__');
  }

  // FAB long-press
  let fabPressTimer: number | null = null;
  let ignoreFabClick = false;

  function handleFabTouchStart(): void {
    fabPressTimer = window.setTimeout(() => {
      oncreatetestnote();
      fabPressTimer = null;
    }, 500);
  }

  function handleFabTouchEnd(): void {
    ignoreFabClick = true;
    window.setTimeout(() => {
      ignoreFabClick = false;
    }, 350);
    if (fabPressTimer !== null) {
      clearTimeout(fabPressTimer);
      fabPressTimer = null;
      onnewnote();
    }
  }

  function handleFabTouchCancel(): void {
    ignoreFabClick = true;
    window.setTimeout(() => {
      ignoreFabClick = false;
    }, 350);
    if (fabPressTimer !== null) {
      clearTimeout(fabPressTimer);
      fabPressTimer = null;
    }
  }

  function handleFabClick(): void {
    if (ignoreFabClick) return;
    if (fabPressTimer !== null) return;
    onnewnote();
  }

  // Sidebar resize
  let resizeStartX = 0;
  let resizeStartWidth = 0;

  function handleResizeStart(e: PointerEvent): void {
    e.preventDefault();
    sidebarResizing = true;
    resizeStartX = e.clientX;
    resizeStartWidth = sidebarWidth;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handleResizeMove(e: PointerEvent): void {
    if (!sidebarResizing) return;
    sidebarWidth = Math.max(180, Math.min(600, resizeStartWidth + (e.clientX - resizeStartX)));
  }

  function handleResizeEnd(): void {
    if (!sidebarResizing) return;
    sidebarResizing = false;
    persistSidebarWidth(sidebarWidth);
  }

  function persistSidebarWidth(width: number): void {
    if (isDesktop) {
      import('$lib/platform/tauri').then(({ saveConfig }) => {
        saveConfig({ sidebarWidth: width });
      });
    } else {
      localStorage.setItem('futo-notes:sidebarWidth', String(width));
    }
  }
</script>

<aside bind:this={drawerEl} class="notes-drawer" aria-hidden={!drawerOpen}>
  <div class="sidebar-header">
    <div class="sidebar-brand">
      <button class="brand-text" onclick={handleBrandClick}>FUTO Notes{#if import.meta.env.DEV}<span class="dev-badge">DEV</span>{/if}</button>
    </div>
    <div class="sidebar-header-actions">
      <button
        class="sidebar-settings-btn"
        aria-label="Settings"
        onclick={onsettings}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
      {#if !isMobile}
        <button class="sidebar-collapse-btn" aria-label="Collapse sidebar"
          onclick={() => { ontogglecollapse(true); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="9" y1="3" x2="9" y2="21"/>
            <polyline points="15 8 12 12 15 16"/>
          </svg>
        </button>
      {/if}
    </div>
  </div>
  <div class="drawer-search-area">
    <button class="search-button" onclick={onsearch}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      Search
    </button>
  </div>
  <div class="sidebar-view-toggle">
    <button class:active={sidebarView === 'notes'} aria-label="Notes view" onclick={() => { sidebarView = 'notes'; localStorage.setItem('futo-notes:sidebarView', 'notes'); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/>
      </svg>
    </button>
    <button class:active={sidebarView === 'tags'} aria-label="Tags view" onclick={() => { sidebarView = 'tags'; localStorage.setItem('futo-notes:sidebarView', 'tags'); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/>
      </svg>
    </button>
    <button class:active={sidebarView === 'images'} aria-label="Images view" onclick={() => { sidebarView = 'images'; localStorage.setItem('futo-notes:sidebarView', 'images'); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
      </svg>
    </button>
  </div>
  {#if sidebarView === 'tags'}
    <SidebarTagView
      notes={appCtx.notes}
      selectedId={appCtx.activeNoteId !== 'new' ? appCtx.activeNoteId : null}
      onselect={onselect}
    />
  {:else if sidebarView === 'images'}
    <SidebarImageView />
  {:else}
    <VirtualList
      items={appCtx.notes}
      selectedId={appCtx.activeNoteId !== 'new' ? appCtx.activeNoteId : null}
      onselect={onselect}
      {isDragging}
    />
  {/if}
  <button
    class="fab"
    aria-label="New note"
    ontouchstart={handleFabTouchStart}
    ontouchend={handleFabTouchEnd}
    ontouchcancel={handleFabTouchCancel}
    onclick={handleFabClick}
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
    New
  </button>
  {#if !isMobile}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="sidebar-resize-handle"
      onpointerdown={handleResizeStart}
      onpointermove={handleResizeMove}
      onpointerup={handleResizeEnd}
      onpointercancel={handleResizeEnd}
    ></div>
  {/if}
</aside>

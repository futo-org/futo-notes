<script lang="ts">
  /**
   * Generic floating context menu. Positions itself at (x, y) and
   * dismisses on outside click / escape. Used for desktop right-click
   * and mobile tap-and-hold flows.
   */

  import { onMount } from 'svelte';
  import { portal } from '$lib/util/portal';

  export interface MenuItem {
    label: string;
    onclick: () => void;
    /** Mark a destructive action (red text). */
    destructive?: boolean;
  }

  interface Props {
    x: number;
    y: number;
    items: MenuItem[];
    onclose: () => void;
  }

  let { x, y, items, onclose }: Props = $props();
  let menuEl: HTMLDivElement | undefined = $state();

  onMount(() => {
    function handleDocClick(e: MouseEvent): void {
      if (menuEl && !menuEl.contains(e.target as Node)) onclose();
    }
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onclose();
    }
    // Defer one frame so the click that opened us doesn't immediately close us.
    const tid = setTimeout(() => {
      document.addEventListener('mousedown', handleDocClick);
      document.addEventListener('touchstart', handleDocClick as unknown as EventListener);
      document.addEventListener('keydown', handleKey);
    }, 0);
    return () => {
      clearTimeout(tid);
      document.removeEventListener('mousedown', handleDocClick);
      document.removeEventListener('touchstart', handleDocClick as unknown as EventListener);
      document.removeEventListener('keydown', handleKey);
    };
  });

  function handleItemClick(item: MenuItem): void {
    item.onclick();
    onclose();
  }
</script>

<div bind:this={menuEl} use:portal class="context-menu" style="left: {x}px; top: {y}px" role="menu">
  {#each items as item (item.label)}
    <button
      type="button"
      role="menuitem"
      class="menu-item"
      class:destructive={item.destructive}
      onclick={() => handleItemClick(item)}>{item.label}</button
    >
  {/each}
</div>

<style>
  .context-menu {
    position: fixed;
    z-index: 200;
    min-width: 160px;
    background: var(--color-bg, #fff);
    color: var(--color-text, #000);
    border: 1px solid var(--color-border, #d1d5db);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
    padding: 4px 0;
  }
  .menu-item {
    display: block;
    width: 100%;
    padding: 6px 12px;
    border: none;
    background: transparent;
    text-align: left;
    cursor: pointer;
    font-size: 0.9rem;
    color: inherit;
  }
  .menu-item:hover {
    background: var(--color-surface, rgba(0, 0, 0, 0.06));
  }
  .menu-item.destructive {
    color: #b91c1c;
  }
</style>

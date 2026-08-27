<script lang="ts">
  import { onMount } from 'svelte';
  import { dismissable } from '$shared/dialogs/dismissable';
  import { portal } from '$shared/dom/portal';
  import { resolveLocalizedMessage, type LocalizedMessage } from '$shared/localization';

  export interface MenuItem {
    label: LocalizedMessage;
    onclick: () => void;
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
    // Escape comes from the shared dialog stack (use:dismissable below), which
    // also guarantees a menu opened over a modal closes the menu, not both.
    const tid = setTimeout(() => {
      document.addEventListener('mousedown', handleDocClick);
      document.addEventListener('touchstart', handleDocClick as unknown as EventListener);
    }, 0);
    return () => {
      clearTimeout(tid);
      document.removeEventListener('mousedown', handleDocClick);
      document.removeEventListener('touchstart', handleDocClick as unknown as EventListener);
    };
  });

  function handleItemClick(item: MenuItem): void {
    item.onclick();
    onclose();
  }
</script>

<div
  bind:this={menuEl}
  use:portal
  use:dismissable={{ ondismiss: onclose }}
  class="context-menu"
  style="left: {x}px; top: {y}px"
  role="menu"
>
  {#each items as item (`${item.label.path}:${JSON.stringify(item.label.arguments ?? {})}`)}
    <button
      type="button"
      role="menuitem"
      class="menu-item"
      class:destructive={item.destructive}
      onclick={() => handleItemClick(item)}>{resolveLocalizedMessage(item.label)}</button
    >
  {/each}
</div>

<style>
  .context-menu {
    position: fixed;
    z-index: var(--z-overlay);
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

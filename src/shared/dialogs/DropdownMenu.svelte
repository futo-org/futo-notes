<script lang="ts">
  import type { Snippet } from 'svelte';
  import { dismissable } from './dismissable';
  import { resolveLocalizedMessage, type LocalizedMessage } from '$shared/localization';

  export interface DropdownMenuItem {
    label: LocalizedMessage;
    onclick: () => void;
    destructive?: boolean;
    checked?: boolean;
    testId?: string;
    disabled?: boolean;
  }

  export interface DropdownMenuHeading {
    heading: LocalizedMessage;
  }

  export type DropdownMenuEntry = DropdownMenuItem | DropdownMenuHeading;

  interface Props {
    open: boolean;
    ontoggle: () => void;
    onclose: () => void;
    entries: DropdownMenuEntry[];
    label: string;
    toggleClass?: string;
    toggleTestId?: string;
    closeOnSelect?: boolean;
    children: Snippet;
  }

  let {
    open,
    ontoggle,
    onclose,
    entries,
    label,
    toggleClass,
    toggleTestId,
    closeOnSelect = true,
    children,
  }: Props = $props();
  let anchorEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent | TouchEvent): void {
      if (anchorEl && !anchorEl.contains(event.target as Node)) onclose();
    }
    // A fixed backdrop cannot cover the page from inside a transformed ancestor
    // (the sidebar drawer), so outside clicks are detected at the document.
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  });

  function handleItemClick(item: DropdownMenuItem): void {
    item.onclick();
    if (closeOnSelect) onclose();
  }

  function entryKey(entry: DropdownMenuEntry): string {
    return 'heading' in entry ? `heading:${entry.heading.path}` : entry.label.path;
  }
</script>

<div class="dropdown-menu-anchor" bind:this={anchorEl}>
  <button
    type="button"
    class={toggleClass}
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={open}
    data-testid={toggleTestId}
    onclick={ontoggle}
  >
    {@render children()}
  </button>

  {#if open}
    <div class="dropdown-menu" role="menu" use:dismissable={{ ondismiss: onclose }}>
      {#each entries as entry (entryKey(entry))}
        {#if 'heading' in entry}
          <div class="dropdown-menu-heading" role="presentation">
            {resolveLocalizedMessage(entry.heading)}
          </div>
        {:else}
          <button
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={entry.checked}
            class:danger={entry.destructive}
            class:checkable={entry.checked !== undefined}
            data-testid={entry.testId}
            disabled={entry.disabled}
            onclick={() => handleItemClick(entry)}
            >{#if entry.checked}<svg
                class="dropdown-menu-check"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg
              >{/if}{resolveLocalizedMessage(entry.label)}</button
          >
        {/if}
      {/each}
    </div>
  {/if}
</div>

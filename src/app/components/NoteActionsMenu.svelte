<script lang="ts">
  interface Props {
    noteId: string;
    open?: boolean;
    showNativeActions: boolean;
    oncopy: () => void;
    ondelete: () => void;
    ongraph: () => void;
    onmove: () => void;
  }

  let {
    noteId,
    open = $bindable(false),
    showNativeActions,
    oncopy,
    ondelete,
    ongraph,
    onmove,
  }: Props = $props();

  function run(action: () => void): void {
    open = false;
    action();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="note-menu-backdrop" onclick={() => (open = false)}></div>
{/if}

<div class="note-menu-anchor">
  <button
    class="note-menu-toggle"
    aria-label="Note options"
    aria-expanded={open}
    onclick={() => (open = !open)}>&#8942;</button
  >
  {#if open}
    <div class="note-menu-dropdown">
      {#if showNativeActions}
        <button onclick={() => run(ongraph)}>Graph view</button>
        <button onclick={() => run(oncopy)}>Copy file path</button>
      {/if}
      {#if noteId !== 'new'}
        <button data-testid="note-menu-move" onclick={() => run(onmove)}>Move to folder</button>
      {/if}
      <button class="danger" onclick={() => run(ondelete)}>Delete note</button>
    </div>
  {/if}
</div>

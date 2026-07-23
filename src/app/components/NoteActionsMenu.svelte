<script lang="ts">
  interface Props {
    open: boolean;
    ontoggle: () => void;
    onclose: () => void;
    ongraphview: () => void;
    oncopypath: () => void;
    onmove: () => void;
    ondelete: () => void;
  }

  let { open, ontoggle, onclose, ongraphview, oncopypath, onmove, ondelete }: Props = $props();
</script>

<div class="note-menu-anchor">
  <button
    class="note-menu-toggle"
    aria-label="Note options"
    aria-expanded={open}
    onclick={ontoggle}
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  </button>

  {#if open}
    <div
      class="note-menu-backdrop"
      role="presentation"
      onclick={onclose}
      oncontextmenu={(e) => {
        e.preventDefault();
        onclose();
      }}
    ></div>
    <div class="note-menu-dropdown" role="menu">
      <button role="menuitem" onclick={ongraphview}>Graph view</button>
      <button role="menuitem" onclick={oncopypath}>Copy file path</button>
      <button role="menuitem" data-testid="note-menu-move" onclick={onmove}>Move to folder</button>
      <button role="menuitem" class="danger" onclick={ondelete}>Delete note</button>
    </div>
  {/if}
</div>

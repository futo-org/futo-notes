<script lang="ts">
  interface Props {
    oncancel: () => void;
    onconfirm: () => void;
  }

  let { oncancel, onconfirm }: Props = $props();

  $effect(() => {
    function handleKeydown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      oncancel();
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="delete-confirm-overlay"
  onclick={oncancel}
  onkeydown={(event) => event.stopPropagation()}
>
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div
    class="delete-confirm-dialog"
    tabindex="-1"
    onclick={(event) => event.stopPropagation()}
    onkeydown={(event) => event.stopPropagation()}
  >
    <h3>Delete this note?</h3>
    <p>This action cannot be undone.</p>
    <div class="delete-confirm-actions">
      <button class="delete-confirm-cancel" onclick={oncancel}>Cancel</button>
      <button class="delete-confirm-delete" onclick={onconfirm}>Delete</button>
    </div>
  </div>
</div>

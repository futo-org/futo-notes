<script lang="ts">
  import { onMount, untrack } from 'svelte';

  import Modal from '$shared/dialogs/Modal.svelte';

  interface Props {
    initialValue?: string;
    title?: string;
    confirmLabel?: string;
    onsubmit: (value: string) => Promise<string | null> | string | null;
    validate?: (value: string) => string | null;
    oncancel: () => void;
  }

  let {
    initialValue = '',
    title = 'New folder',
    confirmLabel = 'Create',
    onsubmit,
    validate,
    oncancel,
  }: Props = $props();

  let value = $state(untrack(() => initialValue));
  let error = $state<string | null>(null);
  let submitting = $state(false);
  let inputEl: HTMLInputElement | undefined = $state();

  const liveError = $derived(validate ? validate(value) : null);
  const shownError = $derived(liveError !== null && value.trim() !== '' ? liveError : error);

  onMount(() => {
    inputEl?.focus();
    inputEl?.select();
  });

  async function handleSubmit(): Promise<void> {
    if (submitting || liveError !== null) return;
    submitting = true;
    error = null;
    try {
      const result = await onsubmit(value);
      if (result !== null) {
        error = result;
      }
    } catch (err) {
      error = (err as Error).message ?? 'Failed';
    } finally {
      submitting = false;
    }
  }

  function handleKey(e: KeyboardEvent): void {
    // Escape is not handled here: Modal owns dismissal for every dialog.
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleSubmit();
    }
  }
</script>

<Modal {title} ondismiss={oncancel}>
  <label class="modal-label">
    Folder name
    <input
      bind:this={inputEl}
      bind:value
      type="text"
      class="modal-input"
      oninput={() => {
        error = null;
      }}
      onkeydown={handleKey}
      autocomplete="off"
      autocapitalize="none"
      enterkeyhint="done"
      spellcheck="false"
      data-testid="create-folder-input"
    />
  </label>
  {#if shownError}
    <div class="modal-error" role="alert">{shownError}</div>
  {/if}
  <div class="modal-actions">
    <button type="button" class="modal-btn modal-btn-secondary" onclick={oncancel}>Cancel</button>
    <button
      type="button"
      class="modal-btn modal-btn-primary"
      onclick={handleSubmit}
      disabled={submitting || liveError !== null}
      data-testid="create-folder-confirm">{confirmLabel}</button
    >
  </div>
</Modal>

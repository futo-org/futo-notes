<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { portal } from '$lib/util/portal';
  import { isMobile } from '$lib/platform';

  interface Props {
    /** Pre-filled value (used by the rename modal). */
    initialValue?: string;
    /** Modal title — "New folder" for create, "Rename folder" for rename. */
    title?: string;
    /** Confirm button label. */
    confirmLabel?: string;
    /** Validate + submit. Return null on success, or an error string to display. */
    onsubmit: (value: string) => Promise<string | null> | string | null;
    /** Optional live validator, re-run on every keystroke. A non-null
     *  return disables the confirm action and is shown as the error
     *  (once the field is non-empty). The submit path stays guarded by
     *  `onsubmit` as a hard backstop. */
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

  // eslint-disable-next-line svelte/valid-each-key
  let value = $state(untrack(() => initialValue));
  let error = $state<string | null>(null);
  let submitting = $state(false);
  let inputEl: HTMLInputElement | undefined = $state();

  const liveError = $derived(validate ? validate(value) : null);
  // An untouched/whitespace-only field is disabled-but-quiet — showing
  // "cannot be empty" before the user types anything reads as a scold.
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
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      oncancel();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div use:portal class="modal-backdrop" class:mobile={isMobile} onclick={oncancel}>
  <div class="modal-card" onclick={(e) => e.stopPropagation()}>
    <h2 class="modal-title">{title}</h2>
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
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal-card {
    background: var(--color-bg, #fff);
    color: var(--color-text, #000);
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
    padding: 20px;
    width: 360px;
    max-width: calc(100% - 32px);
  }
  .modal-title {
    font-weight: 600;
    margin: 0 0 12px;
    font-size: 1.1rem;
  }
  .modal-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.85rem;
    color: var(--color-muted, #666);
  }
  .modal-input {
    border: 1px solid var(--color-border, #d1d5db);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 1rem;
    background: var(--color-surface, #fff);
    color: var(--color-text, #000);
  }
  .modal-input:focus {
    outline: 2px solid var(--color-primary, #2563eb);
    outline-offset: -1px;
  }
  .modal-error {
    margin-top: 8px;
    font-size: 0.85rem;
    color: #b91c1c;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  .modal-btn {
    border-radius: 6px;
    padding: 6px 14px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--color-border, #d1d5db);
    background: transparent;
    color: var(--color-text, inherit);
  }
  .modal-btn-primary {
    background: var(--color-primary, #2563eb);
    color: #fff;
    border-color: var(--color-primary, #2563eb);
  }
  .modal-btn-primary:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  /* Mobile: full-sheet modal that fills the viewport instead of a
     centered card. */
  .modal-backdrop.mobile {
    align-items: stretch;
    justify-content: stretch;
  }
  .modal-backdrop.mobile .modal-card {
    width: 100%;
    max-width: 100%;
    height: 100%;
    border-radius: 0;
    padding: 0 20px max(20px, env(safe-area-inset-bottom, 0));
    display: flex;
    flex-direction: column;
    overflow: auto;
  }
  .modal-backdrop.mobile .modal-actions {
    order: -1;
    position: sticky;
    top: 0;
    z-index: 1;
    margin: 0 -20px 16px;
    padding: calc(max(12px, env(safe-area-inset-top, 0)) + 10px) 20px 12px;
    justify-content: space-between;
    background: var(--color-bg, #fff);
    border-bottom: 1px solid var(--color-border, #d1d5db);
  }
  .modal-backdrop.mobile .modal-title {
    margin-top: 0;
  }
</style>

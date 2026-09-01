<script lang="ts">
  import Modal from './Modal.svelte';
  import { currentConfirmDialog, resolveConfirmDialog } from './confirmDialogState.svelte';

  const request = $derived(currentConfirmDialog());
</script>

{#if request}
  <Modal title={request.title} ondismiss={() => resolveConfirmDialog(false)}>
    <p class="confirm-dialog-message">{request.message}</p>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick={() => resolveConfirmDialog(false)}
        >{request.cancelLabel ?? 'Cancel'}</button
      >
      <button
        class="modal-btn modal-btn-primary"
        class:modal-btn-warning={request.kind === 'warning' || request.kind === 'error'}
        onclick={() => resolveConfirmDialog(true)}>{request.confirmLabel ?? 'Confirm'}</button
      >
    </div>
  </Modal>
{/if}

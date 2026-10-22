<script lang="ts">
  import { puppetVerb } from '$app/puppet/puppetRegistry';
  import { localizedText } from '$shared/localization';

  import Modal from './Modal.svelte';
  import { currentConfirmDialog, resolveConfirmDialog } from './confirmDialogState.svelte';

  const request = $derived(currentConfirmDialog());

  // Cancel is the Modal's own `DismissDialog`. Each answer's verb waits for what it starts.
  const verbs = () => [
    puppetVerb('ConfirmDialog', {}, () => resolveConfirmDialog(true), {
      controls: [request?.confirmLabelKey ?? 'common.actions.confirm'],
    }),
  ];
</script>

{#if request}
  <Modal title={request.title} ondismiss={() => resolveConfirmDialog(false)} {verbs}>
    <p class="confirm-dialog-message">{request.message}</p>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-secondary" onclick={() => resolveConfirmDialog(false)}
        >{localizedText('common.actions.cancel')}</button
      >
      <button
        class="modal-btn modal-btn-primary"
        class:modal-btn-warning={request.kind === 'warning' || request.kind === 'error'}
        onclick={() => resolveConfirmDialog(true)}
        >{localizedText(request.confirmLabelKey ?? 'common.actions.confirm')}</button
      >
    </div>
  </Modal>
{/if}

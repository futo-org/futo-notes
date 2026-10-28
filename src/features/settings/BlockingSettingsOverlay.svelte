<script lang="ts">
  import { localizedText } from '$shared/localization';

  import { puppetModalScope, puppetVerb, registerPuppetVerbs } from '$app/puppet/puppetRegistry';

  interface Props {
    error?: string;
    phase: string;
    oncancel?: () => void;
  }

  let { error = '', phase, oncancel }: Props = $props();

  // Covers the settings panel, so Settings' own verbs are out of reach under it.
  puppetModalScope();
  $effect(() =>
    registerPuppetVerbs(() =>
      oncancel
        ? [
            puppetVerb('CancelBlockingOperation', {}, oncancel, {
              controls: ['common.actions.close'],
            }),
          ]
        : [],
    ),
  );
</script>

<div class="connect-sync-overlay">
  {#if error}
    <div class="connect-sync-error">{error}</div>
    {#if oncancel}
      <button class="connect-sync-cancel" onclick={oncancel}
        >{localizedText('common.actions.close')}</button
      >
    {/if}
  {:else}
    <div class="connect-sync-spinner"></div>
    <div class="connect-sync-phase">{phase}</div>
  {/if}
</div>

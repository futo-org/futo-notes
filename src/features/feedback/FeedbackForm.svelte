<script lang="ts">
  import { Image } from '@lucide/svelte';
  import {
    devCrashlogBaseUrl,
    setUsingStagingCrashlog,
    usingStagingCrashlog,
  } from '$features/system/crashlogEndpoint';

  import { createFeedbackForm } from './createFeedbackForm.svelte';
  import { localizedText } from '$shared/localization';
  import './feedback.css';

  interface Props {
    onsent: () => void;
  }

  let { onsent }: Props = $props();

  const form = createFeedbackForm(() => onsent());

  let useStaging = $state(usingStagingCrashlog());

  $effect(() => () => form.dispose());
</script>

<div class="feedback-form">
  <div class="feedback-message-wrap">
    <textarea
      class="settings-input feedback-message"
      rows="6"
      placeholder={localizedText('feedback.placeholder')}
      value={form.message}
      oninput={(event) => {
        form.setMessage(event.currentTarget.value);
        event.currentTarget.value = form.message;
      }}></textarea>
    <button
      class="feedback-attach"
      aria-label={localizedText('feedback.addScreenshot')}
      title={localizedText('feedback.addScreenshot')}
      disabled={!form.canAttach}
      onclick={() => void form.attachImages()}
    >
      <Image size={18} />
    </button>
  </div>

  {#if form.attachments.length > 0}
    <div class="feedback-attachments">
      {#each form.attachments as attachment, index}
        <div class="feedback-attachment">
          <img
            src={attachment.previewUrl}
            alt={localizedText('feedback.attachedScreenshot', { index: index + 1 })}
          />
          <button
            class="feedback-attachment-remove"
            aria-label={localizedText('feedback.removeScreenshot', { index: index + 1 })}
            onclick={() => form.removeAttachment(index)}>×</button
          >
        </div>
      {/each}
    </div>
  {/if}

  {#if form.error}
    <p class="settings-warning">{form.error}</p>
  {/if}

  <div class="settings-actions feedback-actions">
    <button
      class="settings-btn settings-btn-inline feedback-send"
      disabled={!form.canSend}
      onclick={() => void form.send()}
      >{form.sending
        ? localizedText('feedback.sending')
        : localizedText('common.actions.send')}</button
    >
  </div>

  {#if import.meta.env.DEV}
    <label class="feedback-dev-endpoint">
      <input
        type="checkbox"
        bind:checked={useStaging}
        onchange={() => setUsingStagingCrashlog(useStaging)}
      />
      {localizedText('feedback.stagingServer')} — {devCrashlogBaseUrl(useStaging)}
    </label>
  {/if}
</div>

<script lang="ts">
  import { ANSWER_PARAM, throughConfirmation } from '$app/puppet/puppetConfirm';
  import { puppetRefusal, puppetVerb, registerPuppetVerbs } from '$app/puppet/puppetRegistry';
  import { localizedText } from '$shared/localization';

  interface Props {
    resetting: boolean;
    /** Asks for confirmation, then resets; settles once it has finished or been declined. */
    onreset: () => Promise<void>;
  }

  let { resetting, onreset }: Props = $props();

  $effect(() =>
    registerPuppetVerbs(() => [
      puppetVerb(
        'ResetAllNotes',
        ANSWER_PARAM,
        () => {
          if (resetting) return puppetRefusal(409, 'a reset is already running');
          return throughConfirmation(onreset);
        },
        { controls: ['settings.danger.fullReset'] },
      ),
      // Thrown from a timer, as the click's throw escapes its handler: the inspector would
      // catch it, and the crash handler would never see it.
      ...(import.meta.env.DEV
        ? [
            puppetVerb('TestCrash', {}, () => void setTimeout(testCrash), {
              controls: ['settings.debug.testCrash.title'],
            }),
          ]
        : []),
    ]),
  );

  function testCrash(): void {
    throw new Error('Test crash from Settings');
  }
</script>

<section class="settings-section">
  <h3 class="settings-section-title">{localizedText('settings.sections.dangerZone')}</h3>
  <button
    class="settings-btn settings-btn-danger"
    onclick={() => void onreset()}
    disabled={resetting}
  >
    <span class="settings-btn-text">
      <span class="settings-btn-label">{localizedText('settings.danger.fullReset')}</span>
      <span class="settings-btn-desc">
        {resetting
          ? localizedText('settings.danger.deleting')
          : localizedText('settings.danger.permanentlyRemoveAll')}
      </span>
    </span>
  </button>
  {#if import.meta.env.DEV}
    <button class="settings-btn settings-btn-danger" style="margin-top: 8px" onclick={testCrash}>
      <span class="settings-btn-text">
        <span class="settings-btn-label">{localizedText('settings.debug.testCrash.title')}</span>
        <span class="settings-btn-desc">
          {localizedText('settings.debug.testCrash.desktop.description')}
        </span>
      </span>
    </button>
  {/if}
</section>

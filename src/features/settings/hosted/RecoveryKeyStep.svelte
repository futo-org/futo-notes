<script lang="ts">
  import { puppetRefusal, puppetVerb, registerPuppetVerbs } from '$app/puppet/puppetRegistry';
  import { localizedText } from '$shared/localization';

  interface Props {
    /** The one copy that will ever exist; there is no way to ask for it again. */
    recoveryKey: string;
    /**
     * True when this replaces a key a person already had, rather than being
     * the vault's first. The only difference on screen: one line saying the
     * old key stopped working (parent spec user story 32).
     */
    replaced: boolean;
    saved: boolean;
    busy: boolean;
    onsavedchange: (saved: boolean) => void;
    oncopy: () => Promise<void>;
    /** `path` stands in for the save dialog. */
    onsavefile: (path?: string) => Promise<void>;
    oncontinue: () => Promise<void>;
  }

  let { recoveryKey, replaced, saved, busy, onsavedchange, oncopy, onsavefile, oncontinue }: Props =
    $props();

  const busyRefusal = () => puppetRefusal(409, 'hosted sync is busy');

  $effect(() =>
    registerPuppetVerbs(() => [
      puppetVerb('CopyRecoveryKey', {}, () => (busy ? busyRefusal() : oncopy()), {
        controls: ['sync.hosted.recoveryKey.copy'],
      }),
      puppetVerb(
        'SaveRecoveryKey',
        { path: 'string' },
        (args) => (busy ? busyRefusal() : onsavefile(args.path as string)),
        { controls: ['sync.hosted.recoveryKey.saveFile'] },
      ),
      puppetVerb(
        'SetRecoveryKeySaved',
        { saved: 'boolean' },
        (args) => onsavedchange(args.saved as boolean),
        { controls: ['sync.hosted.recoveryKey.confirmSaved'] },
      ),
      puppetVerb(
        'ContinueRecoveryKey',
        {},
        () => {
          if (!saved) return puppetRefusal(409, 'tick SetRecoveryKeySaved first');
          return busy ? busyRefusal() : oncontinue();
        },
        { controls: ['sync.hosted.recoveryKey.continue'] },
      ),
    ]),
  );
</script>

<p class="hosted-title">{localizedText('sync.hosted.recoveryKey.title')}</p>
<p class="hosted-body">{localizedText('sync.hosted.recoveryKey.body')}</p>
{#if replaced}
  <p class="hosted-body">{localizedText('sync.hosted.recoveryKey.replaced')}</p>
{/if}

<p
  class="hosted-recovery-key"
  aria-label={localizedText('sync.hosted.recoveryKey.accessibilityLabel')}
>
  {recoveryKey}
</p>

<div class="settings-actions">
  <button class="settings-btn settings-btn-inline" onclick={() => void oncopy()} disabled={busy}>
    {localizedText('sync.hosted.recoveryKey.copy')}
  </button>
  <button
    class="settings-btn settings-btn-inline"
    onclick={() => void onsavefile()}
    disabled={busy}
  >
    {localizedText('sync.hosted.recoveryKey.saveFile')}
  </button>
</div>

<p class="hosted-warning">{localizedText('sync.hosted.recoveryKey.warning')}</p>
<p class="hosted-body">{localizedText('sync.hosted.recoveryKey.shownOnce')}</p>

<label class="hosted-checkbox">
  <input
    type="checkbox"
    checked={saved}
    onchange={(event) => onsavedchange(event.currentTarget.checked)}
  />
  {localizedText('sync.hosted.recoveryKey.confirmSaved')}
</label>

<div class="settings-actions">
  <button
    class="settings-btn settings-btn-inline"
    onclick={() => void oncontinue()}
    disabled={!saved || busy}
  >
    {localizedText('sync.hosted.recoveryKey.continue')}
  </button>
</div>

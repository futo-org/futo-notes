<script lang="ts">
  import { localizedText } from '$shared/localization';

  interface Props {
    /** The one copy that will ever exist; there is no way to ask for it again. */
    recoveryKey: string;
    saved: boolean;
    busy: boolean;
    onsavedchange: (saved: boolean) => void;
    oncopy: () => void;
    onsavefile: () => void;
    oncontinue: () => void;
  }

  let { recoveryKey, saved, busy, onsavedchange, oncopy, onsavefile, oncontinue }: Props = $props();
</script>

<p class="hosted-title">{localizedText('sync.hosted.recoveryKey.title')}</p>
<p class="hosted-body">{localizedText('sync.hosted.recoveryKey.body')}</p>

<p
  class="hosted-recovery-key"
  aria-label={localizedText('sync.hosted.recoveryKey.accessibilityLabel')}
>
  {recoveryKey}
</p>

<div class="settings-actions">
  <button class="settings-btn settings-btn-inline" onclick={oncopy} disabled={busy}>
    {localizedText('sync.hosted.recoveryKey.copy')}
  </button>
  <button class="settings-btn settings-btn-inline" onclick={onsavefile} disabled={busy}>
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
  <button class="settings-btn settings-btn-inline" onclick={oncontinue} disabled={!saved || busy}>
    {localizedText('sync.hosted.recoveryKey.continue')}
  </button>
</div>

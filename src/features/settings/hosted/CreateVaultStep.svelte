<script lang="ts">
  import { vaultPasswordStrength } from '$features/sync/vaultPasswordStrength';
  import { localizedText } from '$shared/localization';

  interface Props {
    /** Rust's own minimum, so this screen and the engine cannot disagree. */
    minimumLength: number;
    busy: boolean;
    oncreate: (vaultPassword: string) => void;
  }

  let { minimumLength, busy, oncreate }: Props = $props();

  let password = $state('');
  let repeated = $state('');

  const strength = $derived(vaultPasswordStrength(password, minimumLength));
  const mismatch = $derived(repeated.length > 0 && repeated !== password);
  const ready = $derived([...password].length >= minimumLength && repeated === password && !busy);

  const strengthLabel = $derived(
    strength === 'tooShort'
      ? localizedText('sync.hosted.createVault.strength.tooShort', { minimum: minimumLength })
      : localizedText(`sync.hosted.createVault.strength.${strength}`),
  );

  function submit(): void {
    if (ready) oncreate(password);
  }
</script>

<p class="hosted-title">{localizedText('sync.hosted.createVault.title')}</p>
<p class="hosted-body">{localizedText('sync.hosted.createVault.body')}</p>

<label class="settings-input-label" for="hosted-vault-password">
  {localizedText('sync.hosted.createVault.label')}
</label>
<input
  id="hosted-vault-password"
  class="settings-input"
  type="password"
  bind:value={password}
  placeholder={localizedText('sync.hosted.createVault.placeholder', { minimum: minimumLength })}
  autocapitalize="off"
  autocomplete="new-password"
  spellcheck="false"
/>

<div
  class="hosted-strength"
  role="status"
  aria-label={localizedText('sync.hosted.createVault.strengthAccessibilityLabel', {
    strength: strengthLabel,
  })}
>
  <span class="hosted-strength-track">
    <span class="hosted-strength-fill {strength}"></span>
  </span>
  <span>{strengthLabel}</span>
</div>

<label class="settings-input-label" for="hosted-vault-password-repeat">
  {localizedText('sync.hosted.createVault.repeatLabel')}
</label>
<input
  id="hosted-vault-password-repeat"
  class="settings-input"
  type="password"
  bind:value={repeated}
  placeholder={localizedText('sync.hosted.createVault.repeatPlaceholder')}
  autocapitalize="off"
  autocomplete="new-password"
  spellcheck="false"
  onkeydown={(event) => event.key === 'Enter' && submit()}
/>

{#if mismatch}
  <p class="settings-warning">{localizedText('sync.hosted.createVault.mismatch')}</p>
{/if}

<div class="settings-actions">
  <button class="settings-btn settings-btn-inline" onclick={submit} disabled={!ready}>
    {busy ? localizedText('sync.working') : localizedText('sync.hosted.createVault.button')}
  </button>
</div>

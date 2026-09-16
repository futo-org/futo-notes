<script lang="ts">
  import { vaultPasswordStrength } from '$features/sync/vaultPasswordStrength';
  import { localizedText } from '$shared/localization';

  /**
   * Which of the two screens this is. Everything below the heading is the
   * same either way — the 12-character minimum, the meter, the repeat field —
   * so the two share one component rather than one copying the other.
   */
  export type VaultPasswordPurpose = 'create' | 'change';

  interface Props {
    purpose: VaultPasswordPurpose;
    /** Rust's own minimum, so this screen and the engine cannot disagree. */
    minimumLength: number;
    busy: boolean;
    onsubmit: (vaultPassword: string) => void;
    /** Only the change screen offers a way back; the wizard has none. */
    oncancel?: () => void;
  }

  let { purpose, minimumLength, busy, onsubmit, oncancel }: Props = $props();

  let password = $state('');
  let repeated = $state('');

  const strength = $derived(vaultPasswordStrength(password, minimumLength));
  const mismatch = $derived(repeated.length > 0 && repeated !== password);
  const ready = $derived([...password].length >= minimumLength && repeated === password && !busy);

  const strengthLabel = $derived(
    strength === 'tooShort'
      ? localizedText('sync.hosted.vaultPassword.strength.tooShort', { minimum: minimumLength })
      : localizedText(`sync.hosted.vaultPassword.strength.${strength}`),
  );

  function submit(): void {
    if (ready) onsubmit(password);
  }
</script>

<p class="hosted-title">{localizedText(`sync.hosted.vaultPassword.${purpose}.title`)}</p>
<p class="hosted-body">{localizedText(`sync.hosted.vaultPassword.${purpose}.body`)}</p>

<label class="settings-input-label" for="hosted-vault-password">
  {localizedText('sync.hosted.vaultPassword.label')}
</label>
<input
  id="hosted-vault-password"
  class="settings-input"
  type="password"
  bind:value={password}
  placeholder={localizedText('sync.hosted.vaultPassword.placeholder', { minimum: minimumLength })}
  autocapitalize="off"
  autocomplete="new-password"
  spellcheck="false"
/>

<div
  class="hosted-strength"
  role="status"
  aria-label={localizedText('sync.hosted.vaultPassword.strengthAccessibilityLabel', {
    strength: strengthLabel,
  })}
>
  <span class="hosted-strength-track">
    <span class="hosted-strength-fill {strength}"></span>
  </span>
  <span>{strengthLabel}</span>
</div>

<label class="settings-input-label" for="hosted-vault-password-repeat">
  {localizedText('sync.hosted.vaultPassword.repeatLabel')}
</label>
<input
  id="hosted-vault-password-repeat"
  class="settings-input"
  type="password"
  bind:value={repeated}
  placeholder={localizedText('sync.hosted.vaultPassword.repeatPlaceholder')}
  autocapitalize="off"
  autocomplete="new-password"
  spellcheck="false"
  onkeydown={(event) => event.key === 'Enter' && submit()}
/>

{#if mismatch}
  <p class="settings-warning">{localizedText('sync.hosted.vaultPassword.mismatch')}</p>
{/if}

<div class="settings-actions">
  <button class="settings-btn settings-btn-inline" onclick={submit} disabled={!ready}>
    {busy
      ? localizedText('sync.working')
      : localizedText(`sync.hosted.vaultPassword.${purpose}.button`)}
  </button>
</div>

{#if oncancel}
  <button class="settings-link-btn" onclick={oncancel}>
    {localizedText('sync.hosted.cancel')}
  </button>
{/if}

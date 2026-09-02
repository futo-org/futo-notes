<script lang="ts">
  import type { ThemePreference } from '$features/system/theme';
  import { localizedText } from '$shared/localization';

  interface Props {
    preference: ThemePreference;
    followSystemAccent: boolean;
    showLinuxDesktopOptions: boolean;
    onchange: (theme: ThemePreference) => void;
    onfollowaccentchange: () => void;
  }

  let {
    preference,
    followSystemAccent,
    showLinuxDesktopOptions,
    onchange,
    onfollowaccentchange,
  }: Props = $props();
</script>

<section class="settings-section">
  <h3 class="settings-section-title">{localizedText('settings.sections.appearance')}</h3>
  <div class="settings-card">
    <div
      class="settings-segmented"
      role="tablist"
      aria-label={localizedText('settings.appearance.theme')}
    >
      <button
        class="settings-segment"
        class:active={preference === 'auto'}
        onclick={() => onchange('auto')}
        aria-pressed={preference === 'auto'}>{localizedText('settings.appearance.auto')}</button
      >
      <button
        class="settings-segment"
        class:active={preference === 'dark'}
        onclick={() => onchange('dark')}
        aria-pressed={preference === 'dark'}>{localizedText('settings.appearance.dark')}</button
      >
      <button
        class="settings-segment"
        class:active={preference === 'light'}
        onclick={() => onchange('light')}
        aria-pressed={preference === 'light'}>{localizedText('settings.appearance.light')}</button
      >
    </div>
    <p class="settings-btn-desc settings-hint">{localizedText('settings.appearance.autoHint')}</p>
  </div>
  {#if showLinuxDesktopOptions}
    <button
      class="settings-toggle-row settings-appearance-card"
      aria-pressed={followSystemAccent}
      onclick={onfollowaccentchange}
    >
      <span class="settings-toggle-text">
        <span class="settings-btn-label">Follow system accent color</span>
        <span class="settings-btn-desc">Use your desktop color for buttons and links.</span>
      </span>
      <span class:on={followSystemAccent} class="settings-switch" aria-hidden="true">
        <span class="settings-switch-thumb"></span>
      </span>
    </button>
  {/if}
</section>

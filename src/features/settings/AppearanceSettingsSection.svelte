<script lang="ts">
  import type { ThemePreference } from '$features/system/theme';
  import { localizedText } from '$shared/localization';

  interface Props {
    preference: ThemePreference;
    onchange: (theme: ThemePreference) => void;
  }

  let { preference, onchange }: Props = $props();
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
</section>

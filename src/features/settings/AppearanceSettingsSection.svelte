<script lang="ts">
  import type { ThemePreference } from '$features/system/theme';

  interface Props {
    preference: ThemePreference;
    onchange: (theme: ThemePreference) => void;
  }

  let { preference, onchange }: Props = $props();
</script>

<section class="settings-section">
  <h3 class="settings-section-title">Appearance</h3>
  <div class="settings-card">
    <div class="settings-segmented" role="tablist" aria-label="Theme">
      {#each ['auto', 'dark', 'light'] as theme}
        <button
          class="settings-segment"
          class:active={preference === theme}
          onclick={() => onchange(theme as ThemePreference)}
          aria-pressed={preference === theme}>{theme[0].toUpperCase() + theme.slice(1)}</button
        >
      {/each}
    </div>
    <p class="settings-btn-desc settings-hint">Auto follows your system theme.</p>
  </div>
</section>

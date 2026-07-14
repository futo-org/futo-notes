<script lang="ts">
  interface Props {
    enabled: boolean;
    alwaysSend: boolean;
    ontoggleenabled: () => void;
    ontogglealwayssend: () => void;
  }

  let { enabled, alwaysSend, ontoggleenabled, ontogglealwayssend }: Props = $props();
</script>

<section class="settings-section">
  <h3 class="settings-section-title">Crash Reporting</h3>
  <div
    class="settings-toggle-row"
    onclick={ontoggleenabled}
    role="button"
    tabindex="0"
    onkeydown={(event) => event.key === 'Enter' && ontoggleenabled()}
  >
    <span class="settings-toggle-text">
      <span class="settings-btn-label">Share crash reports</span>
      <span class="settings-btn-desc"
        >Help improve FUTO Notes by sharing anonymous crash logs when they occur</span
      >
    </span>
    <div class="settings-switch" class:on={enabled}><div class="settings-switch-thumb"></div></div>
  </div>
  {#if enabled}
    <div
      class="settings-toggle-row sub"
      onclick={ontogglealwayssend}
      role="button"
      tabindex="0"
      onkeydown={(event) => event.key === 'Enter' && ontogglealwayssend()}
    >
      <span class="settings-toggle-text">
        <span class="settings-btn-label">Always send automatically</span>
        <span class="settings-btn-desc">Send reports without asking each time</span>
      </span>
      <div class="settings-switch" class:on={alwaysSend}>
        <div class="settings-switch-thumb"></div>
      </div>
    </div>
  {/if}
</section>

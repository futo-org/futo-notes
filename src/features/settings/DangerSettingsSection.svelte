<script lang="ts">
  interface Props {
    resetting: boolean;
    onreset: () => void;
  }

  let { resetting, onreset }: Props = $props();

  function testCrash(): void {
    throw new Error('Test crash from Settings');
  }
</script>

<section class="settings-section">
  <h3 class="settings-section-title">Danger zone</h3>
  <button class="settings-btn settings-btn-danger" onclick={onreset} disabled={resetting}>
    <span class="settings-btn-text">
      <span class="settings-btn-label">Full reset</span>
      <span class="settings-btn-desc">
        {resetting ? 'Deleting...' : 'Permanently remove all notes and app data'}
      </span>
    </span>
  </button>
  {#if import.meta.env.DEV}
    <button class="settings-btn settings-btn-danger" style="margin-top: 8px" onclick={testCrash}>
      <span class="settings-btn-text">
        <span class="settings-btn-label">Test crash</span>
        <span class="settings-btn-desc">Throw an error to test crash reporting</span>
      </span>
    </button>
  {/if}
</section>

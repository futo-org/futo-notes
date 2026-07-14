<script lang="ts">
  interface Props {
    notesDirectory: string;
    isCustomDirectory: boolean;
    onchange: () => void;
    onreset: () => void;
  }

  let { notesDirectory, isCustomDirectory, onchange, onreset }: Props = $props();
</script>

<section class="settings-section">
  <h3 class="settings-section-title">Storage</h3>
  <div class="settings-card">
    <p class="settings-btn-desc">{notesDirectory}</p>
    <div class="settings-actions" style="margin-top: 10px">
      <button class="settings-btn settings-btn-inline" onclick={onchange}>Change directory</button>
    </div>
    {#if isCustomDirectory}
      <button class="settings-link-btn" onclick={onreset}>Reset to default</button>
    {/if}
  </div>
</section>

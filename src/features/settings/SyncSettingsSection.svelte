<script lang="ts">
  import { formatRelativeTime } from '$shared/time/formatRelativeTime';

  import type { SyncSettings } from './createSyncSettings.svelte';

  interface Props {
    sync: SyncSettings;
    backgroundError: boolean;
    backgroundErrorMessage: string;
  }

  let { sync, backgroundError, backgroundErrorMessage }: Props = $props();
</script>

<section class="settings-section">
  <h3 class="settings-section-title">Sync</h3>
  <div class="settings-card">
    <label class="settings-input-label" for="sync-url">Server URL</label>
    <input
      id="sync-url"
      class="settings-input"
      class:settings-input-readonly={sync.connected}
      type="text"
      bind:value={sync.url}
      onclick={sync.handleUrlClick}
      readonly={sync.connected}
      placeholder="notes.example.com"
      autocapitalize="off"
      autocomplete="off"
      spellcheck="false"
    />

    {#if !sync.connected}
      <label class="settings-input-label" for="sync-password">Password</label>
      <input
        id="sync-password"
        class="settings-input"
        type="password"
        bind:value={sync.password}
        placeholder="Server password"
        autocapitalize="off"
        autocomplete="current-password"
        spellcheck="false"
      />
      <p class="settings-btn-desc settings-hint">
        Use the password you configured when installing your FUTO Notes server.
      </p>
      <div class="settings-actions">
        <button
          class="settings-btn settings-btn-inline"
          onclick={sync.connect}
          disabled={sync.busy}
        >
          {sync.busy ? 'Working...' : 'Connect'}
        </button>
      </div>
    {:else}
      {#if !sync.passwordSaved}
        <label class="settings-input-label" for="sync-password">Vault password</label>
        <input
          id="sync-password"
          class="settings-input"
          type="password"
          bind:value={sync.password}
          placeholder="Required after restart"
          autocapitalize="off"
          autocomplete="current-password"
          spellcheck="false"
        />
      {:else}
        <p class="settings-btn-desc settings-hint">Password saved on this device.</p>
      {/if}
      <div class="settings-actions">
        <button
          class="settings-btn settings-btn-inline"
          onclick={sync.syncNow}
          disabled={sync.busy}
        >
          {sync.busy ? 'Working...' : 'Sync now'}
        </button>
      </div>
      {#if sync.passwordSaved}
        <button class="settings-link-btn" onclick={() => void sync.forgetPassword()}
          >Forget password</button
        >
      {/if}
      <button class="settings-link-btn" onclick={() => void sync.resetConnection()}
        >Reset connection</button
      >
    {/if}

    <p class="settings-btn-desc settings-hint">
      Last sync: {sync.lastSyncedAt ? formatRelativeTime(sync.lastSyncedAt) : 'never'}
    </p>
    {#if sync.status}
      <p class="settings-btn-desc settings-hint">{sync.status}</p>
    {:else if backgroundError}
      <p class="settings-btn-desc settings-hint">Sync failed: {backgroundErrorMessage}</p>
    {/if}
  </div>
</section>

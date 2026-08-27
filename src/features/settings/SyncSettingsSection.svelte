<script lang="ts">
  import { localizedRelativeTime, localizedText } from '$shared/localization';

  import type { SyncSettings } from './createSyncSettings.svelte';

  interface Props {
    sync: SyncSettings;
    backgroundError: boolean;
    backgroundErrorMessage: string;
    reconnecting: boolean;
  }

  let { sync, backgroundError, backgroundErrorMessage, reconnecting }: Props = $props();
</script>

<section class="settings-section">
  <h3 class="settings-section-title">{localizedText('settings.sections.sync')}</h3>
  <div class="settings-card">
    <label class="settings-input-label" for="sync-url">{localizedText('sync.serverUrl')}</label>
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
      <label class="settings-input-label" for="sync-password"
        >{localizedText('sync.password')}</label
      >
      <input
        id="sync-password"
        class="settings-input"
        type="password"
        bind:value={sync.password}
        placeholder={localizedText('sync.serverPasswordPlaceholder')}
        autocapitalize="off"
        autocomplete="current-password"
        spellcheck="false"
      />
      <p class="settings-btn-desc settings-hint">
        {localizedText('sync.passwordHelp')}
      </p>
      <div class="settings-actions">
        <button
          class="settings-btn settings-btn-inline"
          onclick={sync.connect}
          disabled={sync.busy}
        >
          {sync.busy ? localizedText('sync.working') : localizedText('sync.connect')}
        </button>
      </div>
    {:else}
      {#if !sync.passwordSaved}
        <label class="settings-input-label" for="sync-password"
          >{localizedText('sync.vaultPassword')}</label
        >
        <input
          id="sync-password"
          class="settings-input"
          type="password"
          bind:value={sync.password}
          placeholder={localizedText('sync.restartPasswordPlaceholder')}
          autocapitalize="off"
          autocomplete="current-password"
          spellcheck="false"
        />
      {:else}
        <p class="settings-btn-desc settings-hint">{localizedText('sync.passwordSavedOnDevice')}</p>
      {/if}
      <div class="settings-actions">
        <button
          class="settings-btn settings-btn-inline"
          onclick={sync.syncNow}
          disabled={sync.busy}
        >
          {sync.busy ? localizedText('sync.working') : localizedText('sync.syncNow')}
        </button>
      </div>
      {#if sync.passwordSaved}
        <button class="settings-link-btn" onclick={() => void sync.forgetPassword()}
          >{localizedText('sync.forgetPassword')}</button
        >
      {/if}
      <button class="settings-link-btn" onclick={() => void sync.resetConnection()}
        >{localizedText('sync.resetConnection')}</button
      >
    {/if}

    <p class="settings-btn-desc settings-hint">
      {localizedText('sync.lastSyncValue', {
        time: sync.lastSyncedAt
          ? localizedRelativeTime(sync.lastSyncedAt)
          : localizedText('sync.never'),
      })}
    </p>
    {#if sync.status}
      <p class="settings-btn-desc settings-hint">{sync.status}</p>
    {:else if backgroundError}
      <p class="settings-btn-desc settings-hint">{backgroundErrorMessage}</p>
    {:else if reconnecting}
      <p class="settings-btn-desc settings-hint">{localizedText('sync.status.reconnecting')}</p>
    {/if}
  </div>
</section>

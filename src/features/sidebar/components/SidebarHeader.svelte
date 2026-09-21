<script lang="ts">
  import { PanelLeftClose, Settings } from '@lucide/svelte';
  import { localizedText } from '$shared/localization';

  interface Props {
    oncollapse: () => void;
    onhome: () => void;
    onsettings: () => void;
    /** Desktop hosts the collapse control in the top band instead. */
    showCollapse?: boolean;
  }

  let { oncollapse, onhome, onsettings, showCollapse = true }: Props = $props();
</script>

<div class="sidebar-header">
  <div class="sidebar-brand">
    <button class="brand-text" onclick={onhome}
      >{localizedText('app.name')}{#if import.meta.env.DEV}<span class="dev-badge"
          >{localizedText('app.desktop.developmentBadge')}</span
        >{/if}</button
    >
  </div>
  <div class="sidebar-header-actions">
    <button
      class="sidebar-settings-btn"
      aria-label={localizedText('settings.openAccessibilityLabel')}
      onclick={onsettings}
    >
      <Settings size={20} strokeWidth={1.75} />
    </button>
    {#if showCollapse}
      <button
        class="sidebar-collapse-btn"
        aria-label={localizedText('sidebar.collapseAccessibilityLabel')}
        onclick={oncollapse}
      >
        <PanelLeftClose size={18} strokeWidth={1.75} />
      </button>
    {/if}
  </div>
</div>

<script lang="ts">
  import { Minus, Square, X } from '@lucide/svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';

  const appWindow = getCurrentWindow();
</script>

<header class="titlebar">
  <div class="titlebar-drag" data-tauri-drag-region>
    <span class="titlebar-title" data-tauri-drag-region>FUTO Notes</span>
  </div>
  <div class="titlebar-controls">
    <button class="titlebar-btn" onclick={() => appWindow.minimize()} title="Minimize">
      <Minus size={14} strokeWidth={1.5} />
    </button>
    <button class="titlebar-btn" onclick={() => appWindow.toggleMaximize()} title="Maximize">
      <Square size={11} strokeWidth={1.5} />
    </button>
    <button class="titlebar-btn titlebar-btn-close" onclick={() => appWindow.close()} title="Close">
      <X size={14} strokeWidth={1.5} />
    </button>
  </div>
</header>

<style>
  .titlebar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 36px;
    z-index: 50;
    display: flex;
    align-items: center;
    background: var(--color-sidebar);
    border-bottom: 1px solid var(--color-border);
    user-select: none;
    -webkit-user-select: none;
    font-family: var(--font-sans);
  }

  .titlebar-drag {
    flex: 1;
    height: 100%;
    display: flex;
    align-items: center;
  }

  .titlebar-title {
    padding-left: 12px;
    font-size: 13px;
    color: var(--color-muted);
    pointer-events: none;
  }

  .titlebar-controls {
    display: flex;
    height: 100%;
  }

  .titlebar-btn {
    appearance: none;
    border: none;
    background: transparent;
    width: 46px;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-muted);
    cursor: default;
    padding: 0;
    transition:
      background 0.1s ease,
      color 0.1s ease;
  }

  .titlebar-btn:hover {
    background: rgba(var(--ink-rgb), 0.08);
    color: var(--color-text);
  }

  .titlebar-btn-close:hover {
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
    color: var(--color-danger);
  }
</style>

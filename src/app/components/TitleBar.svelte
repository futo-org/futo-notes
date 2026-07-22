<script lang="ts">
  import { getCurrentWindow } from '@tauri-apps/api/window';

  // Linux-only custom 36px title bar (nav.md §Desktop shell). macOS and Windows
  // use native window chrome, so this component is only rendered on Linux.
  const appWindow = getCurrentWindow();

  function minimize(): void {
    void appWindow.minimize();
  }
  function toggleMaximize(): void {
    void appWindow.toggleMaximize();
  }
  function close(): void {
    void appWindow.close();
  }
</script>

<div class="titlebar" data-tauri-drag-region>
  <span class="titlebar-title">FUTO Notes</span>
  <div class="titlebar-controls">
    <button class="titlebar-btn" aria-label="Minimize" onclick={minimize}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"
        ><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.2" /></svg
      >
    </button>
    <button class="titlebar-btn" aria-label="Maximize" onclick={toggleMaximize}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"
        ><rect
          x="2.5"
          y="2.5"
          width="7"
          height="7"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
        /></svg
      >
    </button>
    <button class="titlebar-btn titlebar-close" aria-label="Close" onclick={close}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"
        ><line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" stroke-width="1.2" /><line
          x1="9"
          y1="3"
          x2="3"
          y2="9"
          stroke="currentColor"
          stroke-width="1.2"
        /></svg
      >
    </button>
  </div>
</div>

<style>
  .titlebar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: var(--titlebar-height, 36px);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px 0 12px;
    background: var(--color-surface, var(--color-bg));
    border-bottom: 1px solid var(--color-border);
    z-index: var(--z-app-chrome);
    user-select: none;
  }

  .titlebar-title {
    font-size: 13px;
    color: var(--color-muted);
    pointer-events: none;
  }

  .titlebar-controls {
    display: flex;
    gap: 2px;
  }

  .titlebar-btn {
    width: 28px;
    height: 24px;
    border: none;
    background: transparent;
    color: var(--color-muted);
    border-radius: 6px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .titlebar-btn:hover {
    background: color-mix(in srgb, var(--color-text) 10%, transparent);
    color: var(--color-text);
  }

  .titlebar-close:hover {
    background: var(--color-danger);
    color: #fff;
  }
</style>

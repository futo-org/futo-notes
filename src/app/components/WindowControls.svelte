<script lang="ts">
  import {
    closeAppWindow,
    minimizeAppWindow,
    toggleMaximizeAppWindow,
    type WindowControl,
  } from '$lib/platform';
  import { localizedText } from '$shared/localization';

  interface Props {
    buttons: WindowControl[];
    side: 'left' | 'right';
  }

  let { buttons, side }: Props = $props();

  const LABEL_PATHS = {
    minimize: 'app.desktop.minimizeWindowAccessibilityLabel',
    maximize: 'app.desktop.maximizeWindowAccessibilityLabel',
    close: 'app.desktop.closeWindowAccessibilityLabel',
  } as const satisfies Record<WindowControl, string>;

  function handleControlClick(control: WindowControl): void {
    if (control === 'minimize') minimizeAppWindow();
    else if (control === 'maximize') toggleMaximizeAppWindow();
    else closeAppWindow();
  }
</script>

<div
  class="window-controls window-controls-{side}"
  aria-label={localizedText('app.desktop.windowControlsAccessibilityLabel')}
>
  {#each buttons as control}
    <button
      class="window-control-btn"
      aria-label={localizedText(LABEL_PATHS[control])}
      onclick={() => handleControlClick(control)}
    >
      {#if control === 'minimize'}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.2" />
        </svg>
      {:else if control === 'maximize'}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <rect
            x="2.5"
            y="2.5"
            width="7"
            height="7"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
          />
        </svg>
      {:else}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" stroke-width="1.2" />
          <line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" stroke-width="1.2" />
        </svg>
      {/if}
    </button>
  {/each}
</div>

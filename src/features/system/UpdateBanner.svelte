<script lang="ts">
  import { updateChecker as upd } from './updateChecker.svelte';

  function primary(): void {
    void upd.install();
  }
</script>

{#if upd.bannerVisible}
  <div class="update-banner">
    <button
      class="update-pill"
      onclick={primary}
      disabled={upd.busy || upd.phase === 'restart'}
      title={upd.phase === 'error' ? upd.error || 'Update failed' : undefined}
    >
      {#if upd.phase === 'available'}
        <span class="update-pill-icon" aria-hidden="true">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M16.5 9.4 7.55 4.24" />
            <path
              d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
            />
            <path d="M3.3 7 12 12l8.7-5" />
            <path d="M12 22V12" />
          </svg>
        </span>
      {/if}

      <span class="update-pill-label">
        {#if upd.phase === 'available'}
          Install v{upd.pending?.version}
        {:else if upd.phase === 'downloading'}
          Downloading… {upd.percent != null ? `${upd.percent}%` : ''}
        {:else if upd.phase === 'installing'}
          Installing…
        {:else if upd.phase === 'restart'}
          Restarting…
        {:else if upd.phase === 'error'}
          Update failed
        {/if}
      </span>

      {#if upd.phase === 'downloading' && upd.percent != null}
        <span class="update-pill-bar" aria-hidden="true">
          <span class="update-pill-bar-fill" style={`width: ${upd.percent}%`}></span>
        </span>
      {/if}
    </button>
  </div>
{/if}

<style>
  .update-banner {
    position: fixed;
    /* Flush in the bottom-right corner, matching the sync indicator + New button. */
    right: max(16px, calc(16px + env(safe-area-inset-right)));
    bottom: max(16px, calc(16px + env(safe-area-inset-bottom)));
    z-index: var(--z-update-banner);
    max-width: calc(100vw - 32px);
    animation: update-banner-in 0.25s ease;
  }

  .update-pill {
    appearance: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 9px;
    max-width: min(360px, calc(100vw - 32px));
    padding: 9px 15px 9px 13px;
    border: none;
    border-radius: 999px;
    background: var(--color-primary);
    /* White on orange in both themes — reads on the brand fill regardless of theme. */
    color: #fff;
    box-shadow: 0 8px 28px rgba(var(--ink-rgb), 0.28);
    font: inherit;
  }

  .update-pill:hover:not(:disabled) {
    filter: brightness(1.05);
  }

  .update-pill:disabled {
    cursor: default;
  }

  .update-pill:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }

  .update-pill-icon {
    flex: none;
    display: grid;
    place-items: center;
  }

  .update-pill-icon svg {
    display: block;
  }

  .update-pill-label {
    font-size: 14px;
    font-weight: 650;
    line-height: 1.2;
    white-space: nowrap;
  }

  .update-pill-bar {
    flex: none;
    width: 56px;
    height: 5px;
    margin-left: 2px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.3);
    overflow: hidden;
  }

  .update-pill-bar-fill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: #fff;
    transition: width 0.2s ease;
  }

  @keyframes update-banner-in {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .update-banner {
      animation: none;
    }
    .update-pill-bar-fill {
      transition: none;
    }
  }
</style>

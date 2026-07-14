<script lang="ts">
  import CrashReportDialog from './features/system/CrashReportDialog.svelte';
  import NotesShell from './app/NotesShell.svelte';
  import TitleBar from './app/components/TitleBar.svelte';
  import UpdateBanner from './features/system/UpdateBanner.svelte';
  import { createAppBootstrap } from './app/createAppBootstrap.svelte';
  import { configureWindowChrome } from './app/configureWindowChrome';
  import { installDevelopmentHooks } from './app/installDevelopmentHooks';
  import { createCrashReporting } from './features/system/createCrashReporting.svelte';
  import { installExternalFileDropGuard } from '$features/system/externalFileDropGuard';
  import { tabsStore } from '$features/tabs/tabsStore.svelte';
  import { noteIdFromHash } from './app/router';

  const showTitleBar = configureWindowChrome();
  installExternalFileDropGuard();

  let toastMessage = $state('');
  let toastTimer: number | null = null;

  function showToast(message: string): void {
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastMessage = message;
    toastTimer = window.setTimeout(() => {
      toastMessage = '';
      toastTimer = null;
    }, 3000);
  }

  const crashReporting = createCrashReporting(showToast);
  const bootstrap = createAppBootstrap({
    initializeCrashReporting: crashReporting.initialize,
    installDevelopmentHooks,
  });
  const noteId = $derived(tabsStore.activeNoteId);

  $effect(() => {
    if (!tabsStore.hydrated) return;

    const activeNoteId = tabsStore.activeNoteId;
    const hash = activeNoteId === null ? '#/' : `#/note/${encodeURIComponent(activeNoteId)}`;
    if (window.location.hash !== hash) {
      history.replaceState(history.state, '', hash);
    }
  });

  $effect(() => {
    function handleHashChange(): void {
      const activeNoteId = noteIdFromHash(window.location.hash);
      if (activeNoteId !== tabsStore.activeNoteId) {
        tabsStore.openNote(activeNoteId, 'current');
      }
    }

    window.addEventListener('hashchange', handleHashChange);
    const stopBootstrap = bootstrap.start();

    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      stopBootstrap();
    };
  });
</script>

{#if bootstrap.initialized}
  {#if showTitleBar}
    <TitleBar />
  {/if}
  <NotesShell {noteId} />
{:else}
  <div class="loading-screen">
    <div class="loading-spinner"></div>
    <div class="loading-step">{bootstrap.step}</div>
  </div>
{/if}

{#if crashReporting.dialogOpen}
  <CrashReportDialog reports={crashReporting.reports} onresolved={crashReporting.resolve} />
{/if}

{#if toastMessage}
  <div class="toast">{toastMessage}</div>
{/if}

<UpdateBanner />

<style>
  .loading-screen {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: var(--color-bg);
  }

  .loading-spinner {
    width: 24px;
    height: 24px;
    border: 2.5px solid var(--color-border);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: loading-spin 0.8s linear infinite;
  }

  .loading-step {
    max-width: 90vw;
    padding: 0 16px;
    color: var(--color-muted, #888);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    text-align: center;
    word-break: break-word;
  }

  @keyframes loading-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>

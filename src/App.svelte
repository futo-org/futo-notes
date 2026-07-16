<script lang="ts">
  import NotesShell from './app/NotesShell.svelte';
  import TitleBar from './app/components/TitleBar.svelte';
  import { configureWindowChrome } from './app/configureWindowChrome';
  import { createAppBootstrap } from './app/createAppBootstrap.svelte';
  import { installDevelopmentHooks } from './app/installDevelopmentHooks';
  import CrashReportDialog from '$features/system/CrashReportDialog.svelte';
  import UpdateBanner from '$features/system/UpdateBanner.svelte';
  import { createCrashReporting } from '$features/system/createCrashReporting.svelte';
  import { installExternalFileDropGuard } from '$features/system/externalFileDropGuard';
  import { currentToastMessage, showGlobalToast } from '$shared/notifications/toastBus.svelte';

  const windowChrome = configureWindowChrome();
  const crashReporting = createCrashReporting(showGlobalToast);
  const bootstrap = createAppBootstrap({
    initializeCrashReporting: crashReporting.initialize,
    installDevelopmentHooks,
  });

  installExternalFileDropGuard();
  const stopBootstrap = bootstrap.start();
  const toastMessage = $derived(currentToastMessage());

  $effect(() => {
    return () => {
      stopBootstrap();
      windowChrome.dispose();
    };
  });
</script>

{#if windowChrome.chrome.showLinuxTitlebar}
  <TitleBar />
{/if}

{#if bootstrap.initialized}
  <NotesShell />
{/if}

<UpdateBanner />

{#if crashReporting.dialogOpen}
  <CrashReportDialog
    reports={crashReporting.reports}
    onresolved={(result) => void crashReporting.resolve(result)}
  />
{/if}

{#if toastMessage}
  <div class="toast">{toastMessage}</div>
{/if}

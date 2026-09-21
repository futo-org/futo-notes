<script lang="ts">
  import NotesShell from './app/NotesShell.svelte';
  import TitleBar from './app/components/TitleBar.svelte';
  import { configureWindowChrome } from './app/configureWindowChrome';
  import { createAppBootstrap } from './app/createAppBootstrap.svelte';
  import { installDesktopContextMenuGuard } from './app/installDesktopContextMenuGuard';
  import { installDevelopmentHooks } from './app/installDevelopmentHooks';
  import CrashReportDialog from '$features/system/CrashReportDialog.svelte';
  import UpdateBanner from '$features/system/UpdateBanner.svelte';
  import { createCrashReporting } from '$features/system/createCrashReporting.svelte';
  import { installExternalFileDropGuard } from '$features/system/externalFileDropGuard';
  import {
    revealAppWindow,
    setApplicationMenuLabels,
    setApplicationWindowTitle,
  } from '$lib/platform';
  import { desktopLocalization, localizedText } from '$shared/localization';
  import { currentToastMessage, showGlobalToast } from '$shared/notifications/toastBus.svelte';

  const windowChrome = configureWindowChrome();
  const crashReporting = createCrashReporting(showGlobalToast);
  const bootstrap = createAppBootstrap({
    initializeCrashReporting: crashReporting.initialize,
    installDevelopmentHooks,
    showToast: showGlobalToast,
  });

  installExternalFileDropGuard();
  const stopContextMenuGuard = installDesktopContextMenuGuard();
  const stopBootstrap = bootstrap.start();
  const toastMessage = $derived(currentToastMessage());

  // The desktop window is created hidden so the launch never shows WKWebView's
  // opaque white (apps/tauri/src-tauri/src/window_reveal.rs). Reveal it as soon
  // as the shell is in the DOM.
  //
  // Deliberately NOT `requestAnimationFrame`: WebKit suspends rendering for an
  // off-screen window, so while the window is hidden `visibilityState` is
  // 'hidden' and rAF never fires at all — measured on this app, the frame
  // callback stayed at 0 for the whole 3s until something else showed the
  // window. Waiting for a paint that cannot happen is a deadlock; a committed
  // DOM is the last signal available before the window goes on screen.
  $effect(() => {
    revealAppWindow();
  });

  $effect(() => {
    desktopLocalization.effectiveLanguage.tag;
    const applicationTitle = import.meta.env.DEV
      ? localizedText('app.desktop.debugDisplayName')
      : localizedText('app.name');
    document.title = applicationTitle;
    setApplicationWindowTitle(applicationTitle);
    setApplicationMenuLabels({
      file: localizedText('app.desktop.menu.file'),
      edit: localizedText('app.desktop.menu.edit'),
      view: localizedText('app.desktop.menu.view'),
      window: localizedText('app.desktop.menu.window'),
      settings: localizedText('app.desktop.menu.settings'),
      newNote: localizedText('app.desktop.menu.newNote'),
      newTab: localizedText('app.desktop.menu.newTab'),
      reopenClosedTab: localizedText('app.desktop.menu.reopenClosedTab'),
      searchNotes: localizedText('app.desktop.menu.searchNotes'),
      closeTab: localizedText('app.desktop.menu.closeTab'),
      closeWindow: localizedText('app.desktop.menu.closeWindow'),
      toggleSidebar: localizedText('app.desktop.menu.toggleSidebar'),
    });
  });

  $effect(() => {
    return () => {
      stopBootstrap();
      stopContextMenuGuard();
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

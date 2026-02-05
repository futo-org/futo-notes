<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { StatusBar, Style } from '@capacitor/status-bar';
  import NotesShell from './components/NotesShell.svelte';
  import { initNotes } from '$lib/notes';

  let hash = $state(window.location.hash.slice(1) || '/');
  let initialized = $state(false);
  let error: string | null = $state(null);

  const noteId = $derived.by(() => {
    if (hash === '/' || hash === '') return null;
    const match = hash.match(/^\/note\/(.+)$/);
    if (match) {
      const id = match[1];
      return id === 'new' ? 'new' : decodeURIComponent(id);
    }
    return null;
  });

  $effect(() => {
    function onHashChange(): void {
      hash = window.location.hash.slice(1) || '/';
    }
    window.addEventListener('hashchange', onHashChange);

    async function init(): Promise<void> {
      try {
        if (Capacitor.isNativePlatform()) {
          await initNotes();
          await StatusBar.setStyle({ style: Style.Light });
          await StatusBar.setBackgroundColor({ color: '#ffffff' });
        }
        initialized = true;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    init();

    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  });
</script>

{#if error}
  <div style="padding: 20px; font-family: system-ui;">
    <h1>Init Error</h1>
    <pre style="white-space: pre-wrap; background: #f0f0f0; padding: 10px; border-radius: 8px;">{error}</pre>
  </div>
{:else if initialized}
  <NotesShell {noteId} />
{:else}
  <!-- Loading -->
{/if}
